// --- Stato Globale ---
let userPool = null;
let cognitoUser = null;
let currentUserAttributes = {};
let currentJobId = null; // mantenuto per compatibilità (usato nel singolo download legacy)
let tempPassword = "";

// Stato multi-file
let activeJobs = []; // [{ jobId, filename, status, downloadUrl }]

// Stato temporaneo per flussi multi-step
let tempUsername = "";
let nextResendAllowedAt = 0;

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

    // Evita che il browser apra il file
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
        document.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    fileInput.addEventListener('change', handleFileSelect);

    // Drag & Drop (supporta più file)
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('active'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('active'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('active');
        if (dropzone.classList.contains('disabled')) return;

        const files = e.dataTransfer.files;
        if (!files || !files.length) return;

        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;

        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    document.getElementById('btn-clear-file').addEventListener('click', clearFileSelection);
    document.getElementById('btn-convert').addEventListener('click', startConversion);
    document.querySelector('.brand').addEventListener('click', () => {
        if (cognitoUser) showView('dashboard');
    });

    validateConversionState();
}


// --- Navigazione / Views ---
function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');

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

// --- Logic: Session & Auth ---

function checkSession() {
    const user = userPool.getCurrentUser();
    if (user) {
        user.getSession((err, session) => {
            if (err || !session.isValid()) {
                console.log("Session invalid or expired.");
                showView('auth');
                return;
            }
            cognitoUser = user;
            loadUserAttributes();
            if (err) {
                console.error("Cannot load attributes on session:", err);
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
            cognitoUser.getSession((err, session) => {
                if (err || !session || !session.isValid()) {
                    console.error("Session not valid after login:", err);
                    setAuthMessage("Sessione non valida dopo il login.", "error");
                    return;
                }

                loadUserAttributes((err) => {
                    if (err) {
                        setAuthMessage("Login ok, ma errore UI/attributi. Guarda console.", "error");
                        return;
                    }
                    showView('dashboard');
                });
            });
        },

        newPasswordRequired: (userAttributes, requiredAttributes) => {
            delete userAttributes.email_verified;

            cognitoUser.challengeName = 'NEW_PASSWORD_REQUIRED';
            cognitoUser.challengeAttributes = userAttributes;

            document.getElementById('modal-change-password').classList.remove('hidden');
            document.getElementById('cp-current').parentElement.classList.add('hidden');
            document.getElementById('cp-current').value = "DUMMY";

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
    ];

    userPool.signUp(email, password, attributeList, null, (err, result) => {
        if (err) {
            setAuthMessage(err.message || "Signup failed.", 'error');
            return;
        }

        tempUsername = email;
        document.getElementById('confirm-email-display').textContent = email;

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

        const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
            Username: tempUsername,
            Password: tempPassword
        });

        cognitoUser = user;
        cognitoUser.authenticateUser(authDetails, {
            onSuccess: () => {
                loadUserAttributes(() => {
                    showView('dashboard');
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

// --- Logica di reinvio del codice ---
function initResendTimer() {
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
        return true;
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
            console.log("Forgot Password success", data);
        },
        onFailure: (err) => {
            console.log(err);
            setAuthMessage("Se l'email esiste, riceverai un codice.", 'success', 'forgot-message');
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

        document.getElementById('form-signin').reset();
        document.getElementById('form-signup').reset();

        showView('auth');
    }
}

// --- User Attributes / Profile ---

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function updateHeaderUI() {
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
            loadUserAttributes();
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

    if (cognitoUser.challengeName === 'NEW_PASSWORD_REQUIRED') {
        cognitoUser.completeNewPasswordChallenge(newPass, cognitoUser.challengeAttributes, {
            onSuccess: (result) => {
                loadUserAttributes();
                showView('dashboard');

                document.getElementById('modal-change-password').classList.add('hidden');
                document.getElementById('cp-current').parentElement.classList.remove('hidden');
                document.getElementById('form-change-pass').reset();
                msgBox.classList.add('hidden');

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

    if (inputFmt === outputFmt) {
        dropzone.classList.add('disabled');
        convertBtn.disabled = true;
        return;
    }
    dropzone.classList.remove('disabled');

    const fileInput = document.getElementById('audio-file');
    convertBtn.disabled = fileInput.files.length === 0;
}

// Gestione selezione file multipli
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const inputFmt = document.getElementById('input-format').value;
    const outputFmt = document.getElementById('output-format').value;

    if (inputFmt === outputFmt) {
        alert("Input e Output devono essere diversi! Cambia uno dei due formati.");
        clearFileSelection();
        return;
    }

    const maxSize = 50 * 1024 * 1024;
    const invalidFiles = [];

    for (const file of files) {
        const fileExt = file.name.split('.').pop().toLowerCase();

        if (file.size > maxSize) {
            invalidFiles.push(`${file.name}: troppo grande (max 50 MB)`);
            continue;
        }

        if (fileExt !== inputFmt) {
            invalidFiles.push(`${file.name}: formato non corretto (atteso .${inputFmt})`);
        }
    }

    if (invalidFiles.length > 0) {
        alert("Alcuni file non sono validi e verranno ignorati:\n\n" + invalidFiles.join("\n"));

        // Ricostruisce l'input solo con i file validi
        const dt = new DataTransfer();
        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (file.size <= maxSize && ext === inputFmt) {
                dt.items.add(file);
            }
        }
        e.target.files = dt.files;

        if (dt.files.length === 0) {
            clearFileSelection();
            return;
        }
    }

    renderFileList(Array.from(e.target.files));
    validateConversionState();
}

// Mostra la lista dei file selezionati nel dropzone
function renderFileList(files) {
    const placeholder = document.getElementById('upload-dropzone').querySelector('.upload-placeholder');
    const listContainer = document.getElementById('file-list-display');
    const listEl = document.getElementById('file-list-items');

    placeholder.classList.add('hidden');
    listContainer.classList.remove('hidden');

    listEl.innerHTML = '';
    files.forEach(file => {
        const li = document.createElement('li');
        li.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        listEl.appendChild(li);
    });
}

function clearFileSelection() {
    const fileInput = document.getElementById('audio-file');
    fileInput.value = "";
    document.getElementById('upload-dropzone').querySelector('.upload-placeholder').classList.remove('hidden');
    document.getElementById('file-list-display').classList.add('hidden');
    document.getElementById('file-list-items').innerHTML = '';
    validateConversionState();
}

// --- Avvia conversione per tutti i file selezionati ---
async function startConversion() {
    const files = Array.from(document.getElementById('audio-file').files);
    const outputFormat = document.getElementById('output-format').value;
    if (!files.length) return;

    // Reset UI
    activeJobs = [];
    const statusBox = document.getElementById('conversion-status');
    statusBox.classList.remove('hidden');
    document.getElementById('progress-state').classList.remove('hidden');
    document.getElementById('success-state').classList.add('hidden');
    document.getElementById('error-state').classList.add('hidden');
    document.getElementById('btn-convert').disabled = true;

    // Render lista progress
    const progressList = document.getElementById('jobs-progress-list');
    progressList.innerHTML = '';
    files.forEach(file => {
        const li = document.createElement('li');
        li.id = `progress-${file.name}`;
        li.innerHTML = `<span class="job-filename">${file.name}</span> — <span class="job-status">In attesa...</span>`;
        progressList.appendChild(li);
    });

    try {
        const session = await new Promise((resolve, reject) => {
            cognitoUser.getSession((err, session) => err ? reject(err) : resolve(session));
        });
        const token = session.getIdToken().getJwtToken();

        // Avvia tutti i job in parallelo
        const jobPromises = files.map(file => convertSingleFile(file, outputFormat, token));
        await Promise.allSettled(jobPromises);

        // Controlla se tutti sono riusciti o meno
        const failed = activeJobs.filter(j => j.status === 'FAILED');
        const succeeded = activeJobs.filter(j => j.status === 'SUCCEEDED');

        document.getElementById('progress-state').classList.add('hidden');

        if (succeeded.length > 0) {
            document.getElementById('success-state').classList.remove('hidden');

            // Genera un bottone download per ogni job riuscito
            const container = document.getElementById('download-buttons-container');
            container.innerHTML = '';
            for (const job of succeeded) {
                const btn = document.createElement('button');
                btn.className = 'btn-dl btn-dl-file';
                btn.textContent = `⬇ Scarica ${job.filename}`;
                btn.addEventListener('click', () => downloadJobResult(token, job.jobId));
                container.appendChild(btn);
            }
        }

        if (failed.length > 0) {
            document.getElementById('error-state').classList.remove('hidden');
        }

    } catch (e) {
        console.error("[X] startConversion error:", e);
        document.getElementById('progress-state').classList.add('hidden');
        document.getElementById('error-state').classList.remove('hidden');
    }

    document.getElementById('btn-convert').disabled = false;
}

// Gestisce il ciclo completo di un singolo file: crea job → upload → confirm → poll
async function convertSingleFile(file, outputFormat, token) {
    const updateStatus = (msg) => {
        const el = document.querySelector(`#progress-${CSS.escape(file.name)} .job-status`);
        if (el) el.textContent = msg;
    };

    updateStatus('Creazione job...');

    try {
        // 1) Crea il job
        const jobRes = await fetch(`${CONFIG.API_BASE_URL}/jobs`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: file.name,
                inputFormat: document.getElementById('input-format').value,
                outputFormat: outputFormat
            })
        });

        if (!jobRes.ok) throw new Error(`Errore creazione job: ${jobRes.status}`);
        const jobData = await jobRes.json();
        const jobId = jobData.jobId;
        const uploadUrl = jobData.uploadUrl;

        activeJobs.push({ jobId, filename: file.name, status: 'PENDING' });
        updateStatus('Upload in corso...');

        // 2) Upload S3
        const upRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
        });
        if (!upRes.ok) throw new Error(`Errore upload S3: ${upRes.status}`);

        // 3) Conferma job
        updateStatus('Conferma job...');
        const confirmRes = await fetch(`${CONFIG.API_BASE_URL}/jobs/${jobId}/confirm`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!confirmRes.ok) throw new Error(`Errore conferma job: ${confirmRes.status}`);

        // 4) Poll
        updateStatus('Conversione in corso...');
        await pollSingleJob(token, jobId, file.name, updateStatus);

    } catch (e) {
        console.error(`[X] ${file.name}:`, e);
        updateStatus('❌ Errore');
        const job = activeJobs.find(j => j.filename === file.name);
        if (job) job.status = 'FAILED';
    }
}

// Poll finché il job non è SUCCEEDED o FAILED
async function pollSingleJob(token, jobId, filename, updateStatus) {
    while (true) {
        await new Promise(r => setTimeout(r, 3000));

        const res = await fetch(`${CONFIG.API_BASE_URL}/jobs/${jobId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const status = data.status;

        if (status === 'SUCCEEDED') {
            updateStatus('✅ Completato');
            const job = activeJobs.find(j => j.jobId === jobId);
            if (job) job.status = 'SUCCEEDED';
            return;
        } else if (status === 'FAILED') {
            updateStatus('❌ Fallito');
            const job = activeJobs.find(j => j.jobId === jobId);
            if (job) job.status = 'FAILED';
            throw new Error(`Job ${jobId} failed on server`);
        }
        // altrimenti continua il polling
    }
}

// Download di un singolo job tramite jobId
async function downloadJobResult(token, jobId) {
    try {
        const res = await fetch(`${CONFIG.API_BASE_URL}/jobs/${jobId}/download`, {
            headers: { 'Authorization': `Bearer ${token}` }
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

// Mantenuto per compatibilità con eventuali chiamate legacy
async function downloadResult() {
    if (!currentJobId) return;
    try {
        const session = await new Promise((resolve, reject) => {
            cognitoUser.getSession((err, session) => err ? reject(err) : resolve(session));
        });
        const token = session.getIdToken().getJwtToken();
        await downloadJobResult(token, currentJobId);
    } catch (e) {
        alert("Errore download: " + e.message);
    }
}


// --- Elimina account ---
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

        document.getElementById('form-signin').reset();
        document.getElementById('form-signup').reset();

        showView('auth');
    });
}