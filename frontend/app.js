// --- Stato Globale ---
let userPool = null;
let cognitoUser = null; // Oggetto utente autenticato corrente
let currentUserAttributes = {}; // { email, sub, custom:username, etc. }
let currentJobId = null;
let tempPassword = "";

// Stato temporaneo per flussi multi-step
let tempUsername = "";
let nextResendAllowedAt = 0; // Timestamp per il cooldown di rispedizione

// --- DOM Elements Override ---
const views = {
    auth: document.getElementById('view-auth'),
    confirm: document.getElementById('view-confirm'),
    forgot: document.getElementById('view-forgot-password'),
    dashboard: document.getElementById('view-dashboard')
};

// --- Inizializzazione ---
window.addEventListener('load', () => {
    console.log("COGNITO_USER_POOL_ID", window.CONFIG?.COGNITO_USER_POOL_ID);
    console.log("COGNITO_CLIENT_ID", window.CONFIG?.COGNITO_CLIENT_ID);
    console.log("API_BASE_URL", window.CONFIG?.API_BASE_URL);

    const ok = initCognito();
    if (!ok) return;

    initUI();
    checkSession();
});


// --- Setup Cognito ---
function initCognito() {
    if (!window.CONFIG?.COGNITO_USER_POOL_ID || !window.CONFIG?.COGNITO_CLIENT_ID) {
        console.error("CONFIG mancante: controlla config.js e l'ordine degli script in index.html");
        alert("Config mancante (config.js). Ricarica la pagina o controlla il deploy.");
        return false;
    }

    const poolData = {
        UserPoolId: window.CONFIG.COGNITO_USER_POOL_ID,
        ClientId: window.CONFIG.COGNITO_CLIENT_ID
    };

    userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
    return true;
}


// --- Inizializzazione UI ---
function initUI() {

    // Schede di autenticazione
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab));
    });

    // Moduli
    document.getElementById('form-signin').addEventListener('submit', handleSignIn);
    document.getElementById('form-signup').addEventListener('submit', handleSignUp);
    document.getElementById('form-confirm-code').addEventListener('submit', handleConfirmCode);
    document.getElementById('form-forgot-request').addEventListener('submit', handleForgotPasswordRequest);
    document.getElementById('form-forgot-reset').addEventListener('submit', handleForgotPasswordReset);
    document.getElementById('form-change-pass').addEventListener('submit', handleChangePassword);

    // Bottoni  
    document.getElementById('btn-resend-code').addEventListener('click', handleResendCode);
    document.getElementById('link-forgot-password').addEventListener('click', (e) => {
        e.preventDefault();
        showView('forgot');
    });
    document.getElementById('btn-back-to-auth').addEventListener('click', () => showView('auth'));

    // Menu Profilo
    const profileBtn = document.getElementById('profileBtn');
    const profileDropdown = document.getElementById('profileDropdown');
    profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        profileDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => profileDropdown.classList.add('hidden'));
    profileDropdown.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('btnLogout').addEventListener('click', handleLogout);
    document.getElementById('btnEditUsername').addEventListener('click', handleEditUsername);
    document.getElementById('btnChangePassword').addEventListener('click', () => {
        document.getElementById('modal-change-password').classList.remove('hidden');
    });
    document.getElementById('btn-close-cp-modal').addEventListener('click', () => {
        document.getElementById('modal-change-password').classList.add('hidden');
    });
    document.getElementById('btnDeleteAccount').addEventListener('click', handleDeleteAccount);

    // Convertitore
    document.getElementById('input-format').addEventListener('change', validateConversionState);
    document.getElementById('output-format').addEventListener('change', validateConversionState);
    document.getElementById('btn-browse').addEventListener('click', () => document.getElementById('audio-file').click());

    const fileInput = document.getElementById('audio-file');
    const dropzone = document.getElementById('upload-dropzone');

    // evita che il browser apra il file in una nuova tab/finestra
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
        document.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    fileInput.addEventListener('change', handleFileSelect);

    // Drag & Drop  
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('active'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('active'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('active');
        if (dropzone.classList.contains('disabled')) return;

        const files = e.dataTransfer.files;
        if (!files || !files.length) return;

        // Mette davvero i file dentro l'input file
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;

        // Riusa lo stesso flusso di "Scegli file"
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    document.getElementById('btn-clear-file').addEventListener('click', clearFileSelection);
    document.getElementById('btn-convert').addEventListener('click', startConversion);
    document.getElementById('btn-download').addEventListener('click', downloadResult);
    document.getElementById('btn-download-report').addEventListener('click', downloadReport);
    document.querySelector('.brand').addEventListener('click', () => {
        if (cognitoUser) showView('dashboard');
    });
    // Abilita il dropzone subito perché i select hanno valori di default
    validateConversionState();
}


// Navigazione / Views
function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');

    // Logica Header
    if (viewName === 'dashboard') {
        document.body.classList.add('authenticated');
    } else {
        document.body.classList.remove('authenticated');
    }
}

function switchAuthTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');

    document.getElementById('tab-signin').classList.add('hidden');
    document.getElementById('tab-signup').classList.add('hidden');
    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
}

function setAuthMessage(msg, type = 'error', containerId = 'auth-message') {
    const box = document.getElementById(containerId);
    box.textContent = msg;
    box.className = `message-box ${type}`;
    if (!msg) box.classList.add('hidden');
    else box.classList.remove('hidden');
}

// Logic: Session & Auth

function checkSession() {
    const user = userPool.getCurrentUser();
    if (user) {
        user.getSession((err, session) => {
            if (err || !session.isValid()) {
                console.log("Session invalid or expired.");
                showView('auth');
                return;
            }
            // Sessione valida    
            cognitoUser = user;
            loadUserAttributes();
            if (err) {
                console.error("Cannot load attributes on session:", err);
                // anche se non carica attributi, entra in dashboard:
                // anche se non carica attributi, entra in dashboard:
                // showView('dashboard');
                showView('auth');
                return;
            }
            showView('dashboard');
        });
    } else {
        showView('auth');
    }
}

function loadUserAttributes(cb) {
    if (!cognitoUser) {
        if (cb) cb(new Error("No cognitoUser"));
        return;
    }

    cognitoUser.getUserAttributes((err, attributes) => {
        if (err) {
            console.error("getUserAttributes error:", err);
            if (cb) cb(err);
            return;
        }

        currentUserAttributes = {};
        attributes.forEach(attr => {
            currentUserAttributes[attr.getName()] = attr.getValue();
        });

        updateHeaderUI();

        if (cb) cb(null);
    });
}


function handleSignIn(e) {
    e.preventDefault();
    const email = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;

    setAuthMessage("");

    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
        Username: email,
        Password: password
    });

    const userData = { Username: email, Pool: userPool };
    cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);

    console.log("CLICK LOGIN");

    cognitoUser.authenticateUser(authDetails, {
        onFailure: (err) => {
            console.error("AUTH FAIL", err);

            if (err.code === 'UserNotConfirmedException') {
                showView('confirm');
                return;
            }

            let message = err.message || "Login fallito.";
            if (err.code === 'NotAuthorizedException' || err.code === 'UserNotFoundException') {
                message = "Email o password errati.";
            }

            setAuthMessage(message, "error");
        },

        onSuccess: (result) => {
            // Aggancia la sessione e poi carica attributi
            console.log("AUTH SUCCESS");
            cognitoUser.getSession((err, session) => {
                console.log("GET SESSION CALLBACK", { err, valid: session?.isValid?.() });
                if (err || !session || !session.isValid()) {
                    console.error("Session not valid after login:", err);
                    setAuthMessage("Sessione non valida dopo il login.", "error");
                    return;
                }

                loadUserAttributes((err) => {
                    console.log("LOAD ATTR CALLBACK", err);
                    if (err) {
                        setAuthMessage("Login ok, ma errore UI/attributi. Guarda console.", "error");
                        return;
                    }
                    showView('dashboard');
                });
            });
        },

        newPasswordRequired: (userAttributes, requiredAttributes) => {
            // Gestione del cambio password obbligatorio per utenti creati dall’amministratore
            // Riutilizziamo la finestra di cambio password ma con una logica specifica
            delete userAttributes.email_verified; // cleanup    

            // Memorizza lo stato specifico della challenge
            cognitoUser.challengeName = 'NEW_PASSWORD_REQUIRED';
            cognitoUser.challengeAttributes = userAttributes;

            // Mostra il modale, nasconde il campo "Password corrente" poiché non è necessario/utilizzato in questa chiamata API, 
            // ma per semplicità in questa API specifica (completeNewPasswordChallenge) inviamo la nuova password.
            // Il campo "Password corrente" dell'interfaccia utente è irrilevante qui.

            document.getElementById('modal-change-password').classList.remove('hidden');
            document.getElementById('cp-current').parentElement.classList.add('hidden'); // Nasconde la password corrente
            document.getElementById('cp-current').value = "DUMMY"; // Ignora il controllo di obbligatorietà se la validazione nativa è già corretta

            setAuthMessage("È richiesta una nuova password al primo accesso.", 'error');
        }
    });
}


function handleSignUp(e) {
    e.preventDefault();
    const email = document.getElementById('signup-email').value.trim();
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;

    tempPassword = password;

    setAuthMessage("");

    const attributeList = [
        new AmazonCognitoIdentity.CognitoUserAttribute({ Name: "email", Value: email }),
        new AmazonCognitoIdentity.CognitoUserAttribute({ Name: "preferred_username", Value: username })
        // preferred_username è una claim standard OIDC che possiamo usare come nome visualizzato
    ];

    userPool.signUp(email, password, attributeList, null, (err, result) => {
        if (err) {
            setAuthMessage(err.message || "Signup failed.", 'error');
            return;
        }

        // Success
        tempUsername = email; // Cognito usa spesso l’email come username, oppure si può usare result.user.getUsername()
        document.getElementById('confirm-email-display').textContent = email;

        // Imposta timer per il reinvio
        initResendTimer();

        showView('confirm');
    });
}

function handleConfirmCode(e) {
    e.preventDefault();
    const code = document.getElementById('otp-code').value.trim();

    if (!tempUsername || !tempPassword) {
        showView('auth');
        return;
    }

    const userData = { Username: tempUsername, Pool: userPool };
    const user = new AmazonCognitoIdentity.CognitoUser(userData);

    user.confirmRegistration(code, true, (err, result) => {
        if (err) {
            setAuthMessage(err.message || "Codice errato.", 'error', 'confirm-message');
            return;
        }

        // Account confermato → auto-login
        const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
            Username: tempUsername,
            Password: tempPassword
        });

        cognitoUser = user;
        cognitoUser.authenticateUser(authDetails, {
            onSuccess: () => {
                loadUserAttributes(() => {
                    showView('dashboard');
                    // Cleanup
                    tempUsername = "";
                    tempPassword = "";
                });
            },
            onFailure: (loginErr) => {
                console.error("Auto-login failed:", loginErr);
                setAuthMessage("Account confermato! Effettua il login.", 'success', 'auth-message');
                switchAuthTab('signin');
                showView('auth');
            }
        });
    });
}

// Logica di reinvio del codice 
function initResendTimer() {
    const btn = document.getElementById('btn-resend-code');
    const timerSpan = document.getElementById('resend-timer');

    // Carica dallo storage
    const stored = localStorage.getItem('nextResendAllowedAt');
    if (stored) {
        nextResendAllowedAt = parseInt(stored, 10);
    } else {
        nextResendAllowedAt = Date.now() + 30000;
        localStorage.setItem('nextResendAllowedAt', nextResendAllowedAt);
    }

    updateTimerUI();
    const interval = setInterval(() => {
        if (updateTimerUI()) clearInterval(interval);
    }, 1000);
}

function updateTimerUI() {
    const btn = document.getElementById('btn-resend-code');
    const timerSpan = document.getElementById('resend-timer');
    const now = Date.now();
    const diff = nextResendAllowedAt - now;

    if (diff <= 0) {
        btn.disabled = false;
        btn.textContent = "Invia nuovo codice";
        timerSpan.classList.add('hidden');
        localStorage.removeItem('nextResendAllowedAt');
        return true; // Ferma l'intervallo
    } else {
        btn.disabled = true;
        const sec = Math.ceil(diff / 1000);
        btn.textContent = `Invia nuovo codice`;
        timerSpan.textContent = `(00:${sec < 10 ? '0' + sec : sec})`;
        timerSpan.classList.remove('hidden');
        return false;
    }
}

function handleResendCode() {
    if (!tempUsername) return;

    const userData = { Username: tempUsername, Pool: userPool };
    const user = new AmazonCognitoIdentity.CognitoUser(userData);

    user.resendConfirmationCode((err, result) => {
        if (err) {
            setAuthMessage("Errore invio codice.", 'error', 'confirm-message');
            return;
        }
        setAuthMessage("Codice inviato nuovamente.", 'success', 'confirm-message');

        // Reset Timer
        nextResendAllowedAt = Date.now() + 30000;
        localStorage.setItem('nextResendAllowedAt', nextResendAllowedAt);
        initResendTimer();
    });
}

// --- Password dimenticata ---
function handleForgotPasswordRequest(e) {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    tempUsername = email;
    setAuthMessage("", 'error', 'forgot-message');

    const userData = { Username: email, Pool: userPool };
    const user = new AmazonCognitoIdentity.CognitoUser(userData);

    user.forgotPassword({
        onSuccess: (data) => {
            // Non dovrebbe succedere direttamente per forgotPassword di solito
            console.log("Forgot Password success logic reached unexpectedly", data);
        },
        onFailure: (err) => {
            // Anti-enumeration: Non rivelare troppo, ma per il debug registriamo
            console.log(err);
            setAuthMessage("Se l'email esiste, riceverai un codice.", 'success', 'forgot-message');
            // Mostra il form di reset 
            document.getElementById('form-forgot-request').classList.add('hidden');
            document.getElementById('form-forgot-reset').classList.remove('hidden');
        },
        inputVerificationCode: (data) => {
            setAuthMessage("Codice inviato! Controlla la mail.", 'success', 'forgot-message');
            document.getElementById('form-forgot-request').classList.add('hidden');
            document.getElementById('form-forgot-reset').classList.remove('hidden');
        }
    });
}

function handleForgotPasswordReset(e) {
    e.preventDefault();
    const code = document.getElementById('reset-code').value.trim();
    const newPass = document.getElementById('reset-new-password').value;
    const confirmPass = document.getElementById('reset-confirm-password').value;

    if (newPass !== confirmPass) {
        setAuthMessage("Le password non coincidono.", 'error', 'forgot-message');
        return;
    }

    const userData = { Username: tempUsername, Pool: userPool };
    const user = new AmazonCognitoIdentity.CognitoUser(userData);

    user.confirmPassword(code, newPass, {
        onSuccess: () => {
            setAuthMessage("Password cambiata con successo! Effettua il login.", 'success', 'auth-message');
            switchAuthTab('signin');
            showView('auth');
            // Cleanup forms
            document.getElementById('form-forgot-reset').reset();
            document.getElementById('form-forgot-request').reset();
        },
        onFailure: (err) => {
            setAuthMessage(err.message || "Errore reset password.", 'error', 'forgot-message');
        }
    });
}

function handleLogout() {
    if (confirm("Sei sicuro di voler uscire?")) {
        if (cognitoUser) cognitoUser.signOut();
        cognitoUser = null;
        currentUserAttributes = {};

        // Pulisci i form
        document.getElementById('form-signin').reset();
        document.getElementById('form-signup').reset();

        showView('auth');
    }
}

//User Attributes / Profile



function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function updateHeaderUI() {
    // Prefer 'preferred_username' -> 'name' -> 'email'
    const dispName =
        currentUserAttributes['preferred_username'] ||
        currentUserAttributes['name'] ||
        currentUserAttributes['email'] ||
        "User";

    const email = currentUserAttributes['email'] || "—";

    setText('dropdown-username', dispName);
    setText('dash-username', dispName);
    setText('dropdown-email', email);
}

function handleEditUsername() {
    const currentName = document.getElementById('dropdown-username').textContent;
    const newName = prompt("Nuovo username:", currentName);

    if (newName && newName !== currentName) {
        const attributeList = [
            new AmazonCognitoIdentity.CognitoUserAttribute({ Name: "preferred_username", Value: newName })
        ];

        cognitoUser.updateAttributes(attributeList, (err, result) => {
            if (err) {
                alert("Errore aggiornamento: " + err.message);
                return;
            }
            // Aggiorna la cache locale e l'interfaccia utente
            //currentUserAttributes['preferred_username'] = newName;
            loadUserAttributes(); // refresh vero
            // updateHeaderUI();
        });
    }
}

function handleChangePassword(e) {
    e.preventDefault();
    const oldPass = document.getElementById('cp-current').value;
    const newPass = document.getElementById('cp-new').value;
    const confirmPass = document.getElementById('cp-confirm').value;
    const msgBox = document.getElementById('cp-message');

    if (newPass !== confirmPass) {
        msgBox.textContent = "Le password non coincidono.";
        msgBox.className = "message-box error";
        msgBox.classList.remove('hidden');
        return;
    }

    // Branch: Challenge vs Normal Change
    if (cognitoUser.challengeName === 'NEW_PASSWORD_REQUIRED') {
        cognitoUser.completeNewPasswordChallenge(newPass, cognitoUser.challengeAttributes, {
            onSuccess: (result) => {
                // Determina se è necessario confermare i dettagli dell’utente oppure se si può accedere direttamente alla dashboard
                // Il risultato può essere una sessione o un oggetto utente, a seconda della versione dell’SDK o del flusso utilizzato
                loadUserAttributes();
                showView('dashboard');

                // Cleanup UI
                document.getElementById('modal-change-password').classList.add('hidden');
                document.getElementById('cp-current').parentElement.classList.remove('hidden'); // Restore
                document.getElementById('form-change-pass').reset();
                msgBox.classList.add('hidden');

                // Cleanup State
                delete cognitoUser.challengeName;
                delete cognitoUser.challengeAttributes;
            },
            onFailure: (err) => {
                msgBox.textContent = err.message || "Errore challenge.";
                msgBox.className = "message-box error";
                msgBox.classList.remove('hidden');
            }
        });
    } else {
        // Standard Cambio Password
        cognitoUser.changePassword(oldPass, newPass, (err, result) => {
            if (err) {
                msgBox.textContent = err.message || "Errore cambio password.";
                msgBox.className = "message-box error";
                msgBox.classList.remove('hidden');
            } else {
                alert("Password modificata con successo!");
                document.getElementById('modal-change-password').classList.add('hidden');
                document.getElementById('form-change-pass').reset();
                msgBox.classList.add('hidden');
            }
        });
    }
}

// --- Conversion Logic ---

function validateConversionState() {
    const inputFmt = document.getElementById('input-format').value;
    const outputFmt = document.getElementById('output-format').value;
    const dropzone = document.getElementById('upload-dropzone');
    const convertBtn = document.getElementById('btn-convert');

    // 1. Blocca se l'input == output
    if (inputFmt === outputFmt) {
        dropzone.classList.add('disabled');
        convertBtn.disabled = true;
        return;
    }
    // Altrimenti abilita
    dropzone.classList.remove('disabled');

    // 2.Abilita la conversione SOLO se c'è il file
    const fileInput = document.getElementById('audio-file');
    convertBtn.disabled = fileInput.files.length === 0;
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const inputFmt = document.getElementById('input-format').value;
    const outputFmt = document.getElementById('output-format').value;

    // Blocca se input == output
    if (inputFmt === outputFmt) {
        alert("Input e Output devono essere diversi! Cambia uno dei due formati.");
        clearFileSelection();
        return;
    }

    // Validazione dimensione
    const maxSize = 50 * 1024 * 1024; // 50MB max
    if (file.size > maxSize) {
        alert("File troppo grande! Max 50 MB.");
        clearFileSelection();
        return;
    }

    // Validazione estensione
    const fileExt = file.name.split('.').pop().toLowerCase();

    if (fileExt !== inputFmt) {
        alert(`Formato file non corretto!\n\nHai selezionato Input Format: ${inputFmt.toUpperCase()}\nMa il file caricato è: ${fileExt.toUpperCase()}\n\nCambia il formato di input o carica un file diverso.`);
        clearFileSelection();
        return;
    }

    // Mostra UI
    document.getElementById('upload-dropzone').querySelector('.upload-placeholder').classList.add('hidden');
    const info = document.getElementById('file-info-display');
    info.classList.remove('hidden');
    info.querySelector('.filename').textContent = file.name;
    info.querySelector('.filesize').textContent = `(${(file.size / 1024 / 1024).toFixed(2)} MB)`;

    validateConversionState();
}

function clearFileSelection() {
    const fileInput = document.getElementById('audio-file');
    fileInput.value = "";
    document.getElementById('upload-dropzone').querySelector('.upload-placeholder').classList.remove('hidden');
    document.getElementById('file-info-display').classList.add('hidden');
    validateConversionState();
}

async function startConversion() {
    const file = document.getElementById('audio-file').files[0];
    const outputFormat = document.getElementById('output-format').value;
    if (!file) return;

    // Reset UI
    const statusBox = document.getElementById('conversion-status');
    statusBox.classList.remove('hidden');
    document.getElementById('progress-state').classList.remove('hidden');
    document.getElementById('success-state').classList.add('hidden');
    document.getElementById('error-state').classList.add('hidden');
    document.getElementById('btn-convert').disabled = true;

    try {
        // Ottieni JWT
        const session = await new Promise((resolve, reject) => {
            cognitoUser.getSession((err, session) => err ? reject(err) : resolve(session));
        });
        const token = session.getIdToken().getJwtToken();
        console.log("[1] JWT OK, len=", token?.length);

        // 1) Creazione Job
        console.log("[2] POST /jobs ->", `${CONFIG.API_BASE_URL}/jobs`);
        const jobRes = await fetch(`${CONFIG.API_BASE_URL}/jobs`, {
            method: 'POST',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: file.name,
                inputFormat: document.getElementById('input-format').value,
                outputFormat: outputFormat
            })
        });

        console.log("[2] /jobs status:", jobRes.status);
        const jobText = await jobRes.text();
        console.log("[2] /jobs body:", jobText);

        if (!jobRes.ok) throw new Error(`Errore creazione job: ${jobRes.status}`);

        const jobData = JSON.parse(jobText);
        currentJobId = jobData.jobId;
        const uploadUrl = jobData.uploadUrl;

        console.log("[2] jobId:", currentJobId);
        console.log("[2] uploadUrl exists?", !!uploadUrl);

        // 2) Upload su S3
        console.log("[3] PUT presigned upload...");
        const upRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
        });
        console.log("[3] upload status:", upRes.status);
        if (!upRes.ok) throw new Error(`Errore upload S3: ${upRes.status}`);

        // 2b) Conferma job (invia a SQS solo dopo upload completato)
        console.log("[3b] POST /jobs/confirm...");
        const confirmRes = await fetch(`${CONFIG.API_BASE_URL}/jobs/${currentJobId}/confirm`, {
            method: 'POST',
            headers: { 'Authorization': token }
        });
        if (!confirmRes.ok) throw new Error(`Errore conferma job: ${confirmRes.status}`);

        // 3) Poll Status
        console.log("[4] start polling status for jobId=", currentJobId);
        pollStatus(token);

    } catch (e) {
        console.log("[X] Conversion failed:", e);
        document.getElementById('progress-state').classList.add('hidden');
        document.getElementById('error-state').classList.remove('hidden');
        document.getElementById('btn-convert').disabled = false;
    }

}

async function pollStatus(token) {
    console.log("[DEBUG] Token:", token);
    console.log("[DEBUG] URL:", `${CONFIG.API_BASE_URL}/jobs/${currentJobId}`);
    if (!currentJobId) return;

    try {
        const res = await fetch(`${CONFIG.API_BASE_URL}/jobs/${currentJobId}`, {
            headers: { 'Authorization': token }
        });
        const data = await res.json();
        const status = data.status;

        if (status === 'SUCCEEDED') {
            document.getElementById('progress-state').classList.add('hidden');
            document.getElementById('success-state').classList.remove('hidden');
            document.getElementById('btn-convert').disabled = false;
        } else if (status === 'FAILED') {
            throw new Error("Conversion failed on server.");
        } else {
            // Continua il polling
            setTimeout(() => pollStatus(token), 3000);
        }
    } catch (e) {
        console.log("[X] Conversion failed:", e);
        document.getElementById('progress-state').classList.add('hidden');
        document.getElementById('error-state').classList.remove('hidden');
        document.getElementById('btn-convert').disabled = false;
    }
}

async function downloadResult() {
    if (!currentJobId) return;

    try {
        const session = await new Promise((resolve, reject) => {
            cognitoUser.getSession((err, session) => err ? reject(err) : resolve(session));
        });
        const token = session.getIdToken().getJwtToken();

        const res = await fetch(`${CONFIG.API_BASE_URL}/jobs/${currentJobId}/download`, {
            headers: { 'Authorization': token }
        });
        const data = await res.json();

        if (data.downloadUrl) {
            window.location.href = data.downloadUrl;
        } else {
            alert("URL download non disponibile.");
        }
    } catch (e) {
        alert("Errore download: " + e.message);
    }
}


// Elimina account
function handleDeleteAccount() {
    if (!confirm("Sei sicuro di voler eliminare il tuo account?\n\nQuesta azione è IRREVERSIBILE.\n\nTutti i tuoi dati e conversioni saranno persi per sempre.")) {
        return;
    }

    if (!cognitoUser) {
        alert("Errore: utente non autenticato.");
        return;
    }

    cognitoUser.deleteUser((err) => {
        if (err) {
            alert("Errore eliminazione account: " + err.message);
            console.error("Delete user error:", err);
            return;
        }

        alert("Account eliminato con successo.");
        cognitoUser = null;
        currentUserAttributes = {};

        // Pulisci form
        document.getElementById('form-signin').reset();
        document.getElementById('form-signup').reset();

        showView('auth');
    });

    document.getElementById('btn-download-report').addEventListener('click', downloadReport);
}