<img src="https://github.com/user-attachments/assets/ad4f02ad-a498-41f2-a2b8-6a6729002732" style="width:100%; height:auto;" />
WaveShift è un'applicazione cloud-native progettata per l’elaborazione asincrona di file audio su AWS.
Il sistema implementa un’architettura event-driven e scalabile basata su servizi managed, con Infrastructure as Code e CI/CD automatizzata.

## Architettura

L’applicazione utilizza i seguenti servizi AWS:

**Amazon S3** – Storage file audio (input/output)

**Amazon API Gateway** – Endpoint REST per creazione job

**AWS Lambda** – Gestione creazione job e orchestrazione

**Amazon SQS** – Coda asincrona per buffering richieste

**Amazon ECS Fargate** – Worker containerizzati per elaborazione audio

**Amazon DynamoDB** – Persistenza stato job

**Amazon ECR** – Repository immagini Docker

**CloudFormation** – Provisioning infrastruttura

**GitHub Actions** – Pipeline CI/CD


## Requisiti

- AWS CLI configurata
  
- Permessi IAM per deploy CloudFormation
  
- Docker installato
  
- Account AWS con credenziali valide

- Un dominio email valido (per Cognito)


## Deploy

Il deploy dell’infrastruttura e dell’applicazione avviene tramite GitHub Actions.

1. Vai nel repository GitHub e apri la tab **Actions**.
2. Seleziona il workflow **Full Deploy**.
3. Apri l’ultima esecuzione completata con successo.
4. Vai nella sezione **Deploy summary**.
5. L’URL dell’applicazione è riportato nel riepilogo del deploy.

## Accesso alla demo

Per accedere all’applicazione è sufficiente aprire l’URL riportato nella sezione **Deploy summary** dell’ultimo workflow completato oppure cliccare qui: 
    https://d32o4h66h8ay8h.cloudfront.net

> Nota: l’URL può variare in caso di ricreazione dello stack o modifica dello stage API durante un nuovo deploy.
