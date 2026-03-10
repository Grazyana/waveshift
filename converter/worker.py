import boto3
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

sqs = boto3.client('sqs')
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

QUEUE_URL = os.environ['SQS_QUEUE_URL']
JOBS_TABLE = os.environ['JOBS_TABLE']
REGION = os.environ['AWS_REGION']

def process_message(msg):
    body = json.loads(msg['Body'])
    job_id = body['jobId']
    input_bucket = body['inputBucket']
    input_key = body['inputKey']
    output_bucket = body['outputBucket']
    output_key = body['outputKey']
    output_format = (body.get('outputFormat') or 'mp3').lower()

    # Mappa formato → argomenti ffmpeg
    codec_map = {
        'mp3': ['-acodec', 'libmp3lame'],
        'wav': ['-acodec', 'pcm_s16le'],
        'm4a': ['-acodec', 'aac'],
        'ogg': ['-acodec', 'libvorbis']
    }
    codec_args = codec_map.get(output_format, ['-acodec', 'libmp3lame'])

    table = dynamodb.Table(JOBS_TABLE)

    try:
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression="SET #s = :s, updatedAt = :t",
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'PROCESSING', ':t': str(int(time.time()))}
        )

        ext = os.path.splitext(input_key)[1]
        # Path univoci per job_id — evita collisioni in parallelo
        local_input = f"/tmp/input_{job_id}{ext}"
        local_output = f"/tmp/output_{job_id}.{output_format}"

        print(f"[{job_id}] Downloading from bucket: {input_bucket}, key: {input_key}")
        s3.download_file(input_bucket, input_key, local_input)

        print(f"[{job_id}] Running ffmpeg...")
        subprocess.run(
            ['ffmpeg', '-y', '-i', local_input, '-vn'] + codec_args + [local_output],
            check=True
        )

        print(f"[{job_id}] Uploading to bucket: {output_bucket}, key: {output_key}")
        s3.upload_file(local_output, output_bucket, output_key)

        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression="SET #s = :s, updatedAt = :t",
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'SUCCEEDED', ':t': str(int(time.time()))}
        )

        sqs.delete_message(
            QueueUrl=QUEUE_URL,
            ReceiptHandle=msg['ReceiptHandle']
        )
        print(f"[{job_id}] Job completed successfully.")

    except Exception as e:
        print(f"[{job_id}] Error: {e}")
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression="SET #s = :s, updatedAt = :t, #e = :e",
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':s': 'FAILED', ':t': str(int(time.time())), ':e': str(e)}
        )

    finally:
        # Pulizia file temporanei
        for f in [local_input, local_output]:
            if os.path.exists(f):
                os.remove(f)

def main():
    print("Worker started")
    while True:
        try:
            print("Polling SQS...")
            response = sqs.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=10,   # fino a 10 messaggi per polling
                WaitTimeSeconds=20
            )
            messages = response.get('Messages', [])
            print(f"Received {len(messages)} messages")

            if messages:
                with ThreadPoolExecutor(max_workers=4) as executor:
                    for msg in messages:
                        executor.submit(process_message, msg)

        except Exception as e:
            print(f"Polling error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()