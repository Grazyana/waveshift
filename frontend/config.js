window.CONFIG = {
    // URL base dell'API Gateway (es. https://xyz.execute-api.us-east-1.amazonaws.com/prod)
    API_BASE_URL: "https://nbjgo2lc7j.execute-api.eu-north-1.amazonaws.com/prod",

    //  Configurazione Cognito
    COGNITO_CLIENT_ID: "36l8cv0gnjjua51kji8ctldksr",
    COGNITO_DOMAIN: "waveshift-622221238813.auth.eu-north-1.amazoncognito.com", // es. "my-app.auth.us-east-1.amazoncognito.com" SENZA https://
    COGNITO_USER_POOL_ID: "eu-north-1_fymmHAvgc",
    REDIRECT_URI: "https://d3aok89oc1in25.cloudfront.net", // URL dove gira questa pagina

    // S3 Region (opzionale, se serve per costuire URL manuali)
    AWS_REGION: "eu-north-1"
};
