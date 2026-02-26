import boto3
import json
import os
import subprocess
import time

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
    output_format = (body.get('outputFormat') or 'mp3').lower()  # legge il formato, fallback mp3

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
        local_input = f"/tmp/input{ext}"
        local_output = f"/tmp/output.{output_format}"  # estensione dinamica
        
        print(f"Downloading from bucket: {input_bucket}, key: {input_key}")
        s3.download_file(input_bucket, input_key, local_input)
        print("prova")

        # Comando ffmpeg con codec dinamico
        subprocess.run(
            ['ffmpeg', '-y', '-i', local_input, '-vn'] + codec_args + [local_output],
            check=True
        )
        print("prova")
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
        
    except Exception as e:
        print(f"Error processing job {job_id}: {e}")
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression="SET #s = :s, updatedAt = :t, #e = :e",
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':s': 'FAILED', ':t': str(int(time.time())), ':e': str(e)}
        )
        return

def main():
    print("Worker started")
    while True:
        try:
            print("Polling SQS...")  
            response = sqs.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=1,
                WaitTimeSeconds=20
            )
            messages = response.get('Messages', [])
            print(f"Received {len(messages)} messages")  
            for msg in messages:
                process_message(msg)
                
        except Exception as e:
            print(f"Polling error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
