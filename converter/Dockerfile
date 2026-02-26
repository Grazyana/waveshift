FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker.py .

RUN pip install boto3

CMD ["python", "-u", "worker.py"]
