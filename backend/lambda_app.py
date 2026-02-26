import json
import uuid
import os
import boto3
import time

s3 = boto3.client('s3')
sqs = boto3.client('sqs')
dynamodb = boto3.resource('dynamodb')

JOBS_TABLE = os.environ['JOBS_TABLE']
INPUT_BUCKET = os.environ['INPUT_BUCKET']
OUTPUT_BUCKET = os.environ['OUTPUT_BUCKET']
QUEUE_URL = os.environ['SQS_QUEUE_URL']

def handler(event, context):
    try:
        method = event['httpMethod']
        path = event['resource']
        claims = event['requestContext']['authorizer']['claims']
        user_id = claims['sub']

        if method == 'POST' and path == '/jobs':
            # Legge i formati dal body della richiesta
            body = json.loads(event.get('body') or '{}')
            output_format = (body.get('outputFormat') or 'mp3').lower()
            input_format = (body.get('inputFormat') or 'mp3').lower()

            job_id = str(uuid.uuid4())
            # Usa il formato corretto nell'estensione dei file
            input_key = f"{user_id}/{job_id}/input.{input_format}"
            output_key = f"{user_id}/{job_id}/output.{output_format}"

            presigned_url = s3.generate_presigned_url(
                'put_object',
                Params={'Bucket': INPUT_BUCKET, 'Key': input_key},
                ExpiresIn=300
            )

            table = dynamodb.Table(JOBS_TABLE)
            table.put_item(Item={
                'jobId': job_id,
                'userId': user_id,
                'status': 'STARTED',
                'inputKey': input_key,
                'outputKey': output_key,
                'createdAt': str(int(time.time())),
                'updatedAt': str(int(time.time()))
            })

            """sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({
                    'jobId': job_id,
                    'userId': user_id,
                    'inputBucket': INPUT_BUCKET,
                    'inputKey': input_key,
                    'outputBucket': OUTPUT_BUCKET,
                    'outputKey': output_key,
                    'outputFormat': output_format
                })
            )"""

            return response(200, {'jobId': job_id, 'uploadUrl': presigned_url})
        
        
        elif method == 'GET' and path == '/jobs/{jobId}':
            job_id = event['pathParameters']['jobId']
            table = dynamodb.Table(JOBS_TABLE)
            item = table.get_item(Key={'jobId': job_id}).get('Item')
            
            if not item or item['userId'] != user_id:
                return response(404, {'error': 'Job not found'})
                
            return response(200, item)

        elif method == 'GET' and path == '/jobs/{jobId}/download':
            job_id = event['pathParameters']['jobId']
            table = dynamodb.Table(JOBS_TABLE)
            item = table.get_item(Key={'jobId': job_id}).get('Item')
            
            if not item or item['userId'] != user_id:
                return response(404, {'error': 'Job not found'})
            
            if item['status'] != 'SUCCEEDED':
                return response(400, {'error': 'Job not ready'})
                
            download_url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': OUTPUT_BUCKET, 'Key': item['outputKey']},
                ExpiresIn=300
            )
            
            return response(200, {'downloadUrl': download_url})

        elif method == 'POST' and path == '/jobs/{jobId}/confirm':
            job_id = event['pathParameters']['jobId']
            table = dynamodb.Table(JOBS_TABLE)
            item = table.get_item(Key={'jobId': job_id}).get('Item')
            print(f"method={event.get('httpMethod')}, path={event.get('resource')}")

            if not item or item['userId'] != user_id:
                return response(404, {'error': 'Job not found'})

            sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({
                    'jobId': job_id,
                    'userId': user_id,
                    'inputBucket': INPUT_BUCKET,
                    'inputKey': item['inputKey'],
                    'outputBucket': OUTPUT_BUCKET,
                    'outputKey': item['outputKey'],
                    'outputFormat': item['outputKey'].split('.')[-1]
                })
            )

            return response(200, {'message': 'Job queued'})

        return response(400, {'error': 'Invalid request'})

    except Exception as e:
        print(e)
        return response(500, {'error': str(e)})

def response(code, body):
    return {
        'statusCode': code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': True
        },
        'body': json.dumps(body)
    }
