const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
//const fs = require('fs').promises;
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const rateLimit = require('express-rate-limit');
const { log } = require('console');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(express.json({ limit: '10mb' }));

// Debugging helpers and per-request IDs for traceability
function timeStamp() {
  return new Date().toISOString();
}

function debugLog(requestId, ...args) {
  const prefix = requestId ? `[${timeStamp()}] [req:${requestId}]` : `[${timeStamp()}]`;
  console.log(prefix, ...args);
}

// Assign a request ID and log incoming request details
app.use((req, res, next) => {
  try {
    req.requestId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomBytes(8).toString('hex');
  } catch (e) {
    req.requestId = Date.now().toString(36);
  }
  req._startTime = Date.now();

  const remoteIp = req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || req.ip;
  debugLog(req.requestId, 'Incoming', req.method, req.originalUrl, 'from', remoteIp);
  debugLog(req.requestId, 'Headers:', Object.assign({}, req.headers));
  // Don't log huge bodies fully — show length and a safe preview
  if (req.body) {
    try {
      const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const preview = bodyStr.length > 1000 ? bodyStr.slice(0, 1000) + '...<truncated>' : bodyStr;
      debugLog(req.requestId, 'Body size:', Buffer.byteLength(bodyStr, 'utf8'), 'preview:', preview);
    } catch (e) {
      debugLog(req.requestId, 'Body: <unserializable>');
    }
  }
  // hook into response finish to log outcome and duration
  res.on('finish', () => {
    const durationMs = Date.now() - req._startTime;
    debugLog(req.requestId, 'Response', res.statusCode, 'completed in', durationMs + 'ms');
  });

  next();
});

// Security: Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many deploy requests from this IP, please try again later.'
});
//app.use('/deploy', limiter);

// Load environment configuration
const PROJECTS = {};
log('Loading project configuration...');
log('the env has variables:', process.env);
if (process.env.DEPLOY_PROJECTS) {
  console.log('Loading project configuration from environment variable.');
  try {
    const projectsConfig = JSON.parse(process.env.DEPLOY_PROJECTS);
    console.log('Loaded project configuration:', projectsConfig);
    Object.keys(projectsConfig).forEach(projectName => {
      PROJECTS[projectName] = {
        dir: projectsConfig[projectName].dir,
        pm2Name: projectsConfig[projectName].pm2Name,
        secret: projectsConfig[projectName].secret,
        branch: projectsConfig[projectName].branch || 'main'
      };
    });
  } catch (e) {
    console.error('Invalid DEPLOY_PROJECTS format:', e);
    process.exit(1);
  }
}

// File lock to prevent concurrent deploys
const LOCK_FILE = '/tmp/deploy-webhook.lock';
let isDeploying = false;

function acquireLock() {
  return new Promise((resolve, reject) => {
    if (isDeploying) {
      reject(new Error('Another deployment is in progress'));
      return;
    }
    isDeploying = true;
    resolve();
  });
}

function releaseLock() {
  isDeploying = false;
}

// Execute shell commands with proper error handling
function execPromise(command, cwd, requestId) {
  return new Promise((resolve, reject) => {
    debugLog(requestId, 'Exec start:', command, 'cwd=', cwd);
    const child = exec(command, { cwd, timeout: 300000 }); // 5 minute timeout
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data;
      debugLog(requestId, `[STDOUT] ${data}`);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data;
      debugLog(requestId, `[STDERR] ${data}`);
    });
    
    child.on('close', (code) => {
      debugLog(requestId, 'Exec finished:', command, 'code=', code);
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`Command failed with code ${code}: ${stderr}`);
        debugLog(requestId, 'Exec error:', err.message);
        reject(err);
      }
    });
    
    child.on('error', (error) => {
      debugLog(requestId, 'Exec process error:', error && error.message);
      reject(error);
    });
  });
}

// Verify GitHub webhook signature
function verifySignature(payload, signature, secret) {
  try {
    const expectedHex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const expectedSignature = 'sha256=' + expectedHex;
    log('verifySignature expected:', expectedSignature);
    log('verifySignature actual:', signature);
    if (!signature || typeof signature !== 'string') return false;
    // timingSafeEqual requires equal-length buffers
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length) {
      log('Signature length mismatch');
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (e) {
    log('Signature verification error:', e && e.message);
    return false;
  }
}

// Main deployment function
async function deployProject(projectName, branch = 'main', requestId) {
  requestId = requestId || 'no-req-id';
  const project = PROJECTS[projectName];
  if (!project) {
    throw new Error(`Project ${projectName} not configured`);
  }

  if (!fs.existsSync(project.dir)) {
    throw new Error(`Project directory ${project.dir} does not exist`);
  }

  console.log(`Starting deployment for ${projectName} on branch ${branch}`);
  debugLog(requestId, `Starting deployment for ${projectName} on branch ${branch}`);
  try {
    // Git operations
    await execPromise('git fetch --all', project.dir, requestId);
    await execPromise(`git reset --hard origin/${branch}`, project.dir, requestId);
    
    // Install dependencies
//    await execPromise('npm ci --prefer-offline --no-audit --progress=false', project.dir);
    await execPromise('npm i', project.dir, requestId);
    
    // Build if needed (optional)
//    if (fs.existsSync(path.join(project.dir, 'package.json'))) {
//      const packageJson = JSON.parse(await fs.readFile(path.join(project.dir, 'package.json'), 'utf8'));
if (fs.existsSync(path.join(project.dir, 'package.json'))) {
      const packageJson = JSON.parse(await fsp.readFile(path.join(project.dir, 'package.json'), 'utf8'));
      if (packageJson.scripts && packageJson.scripts.build) {
        await execPromise('npm run build', project.dir, requestId);
      }
    }
    
    // Restart PM2
    await execPromise(`pm2 restart ${project.pm2Name}`, project.dir, requestId);
    
    debugLog(requestId, `Deployment completed for ${projectName}`);
    return `Successfully deployed ${projectName}`;
    
  } catch (error) {
    debugLog(requestId, `Deployment failed for ${projectName}:`, error && error.message);
    
    // Try to restart PM2 anyway to recover from partial failures
    try {
      await execPromise(`pm2 restart ${project.pm2Name}`, project.dir, requestId);
    } catch (restartError) {
      debugLog(requestId, `Failed to restart PM2 after deployment failure:`, restartError && restartError.message);
    }
    
    throw error;
  }
}

// Webhook endpoint
app.post('/deploy/:projectName', async (req, res) => {
  const projectName = req.params.projectName;
  const project = PROJECTS[projectName];
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  // Verify webhook signature
  const signature = req.headers['x-hub-signature-256'];
  const payload = JSON.stringify(req.body);
  log('Received payload:', payload);

  if (!signature || !verifySignature(payload, signature, project.secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Verify branch (if specified in webhook)
  const branch = req.body.ref ? req.body.ref.replace('refs/heads/', '') : project.branch;
  if (branch !== project.branch) {
    return res.status(200).json({ 
      message: `Ignoring deployment: branch ${branch} != ${project.branch}` 
    });
  }

  try {
    await acquireLock();
    const result = await deployProject(projectName, branch);
    releaseLock();
    res.status(200).json({ success: true, message: result });
  } catch (error) {
    releaseLock();
    console.error('Deployment error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Deployment failed' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    projects: Object.keys(PROJECTS),
    timestamp: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Configured projects: ${Object.keys(PROJECTS).join(', ')}`);
});

