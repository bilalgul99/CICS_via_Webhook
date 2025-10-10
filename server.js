const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const rateLimit = require('express-rate-limit');
const { log } = require('console');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(express.json({ limit: '10mb' }));

// Security: Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many deploy requests from this IP, please try again later.'
});
app.use('/deploy', limiter);

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
function execPromise(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { cwd, timeout: 300000 }); // 5 minute timeout
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data;
      console.log(`[STDOUT] ${data}`);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data;
      console.error(`[STDERR] ${data}`);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
  });
}

// Verify GitHub webhook signature
function verifySignature(payload, signature, secret) {
  const expectedSignature = 'sha256=' + 
    crypto.createHmac('sha256', secret)
          .update(payload)
          .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Main deployment function
async function deployProject(projectName, branch = 'main') {
  const project = PROJECTS[projectName];
  if (!project) {
    throw new Error(`Project ${projectName} not configured`);
  }

  if (!fs.existsSync(project.dir)) {
    throw new Error(`Project directory ${project.dir} does not exist`);
  }

  console.log(`Starting deployment for ${projectName} on branch ${branch}`);
  
  try {
    // Git operations
    await execPromise('git fetch --all', project.dir);
    await execPromise(`git reset --hard origin/${branch}`, project.dir);
    
    // Install dependencies
    await execPromise('npm ci --prefer-offline --no-audit --progress=false', project.dir);
    
    // Build if needed (optional)
    if (fs.existsSync(path.join(project.dir, 'package.json'))) {
      const packageJson = JSON.parse(await fs.readFile(path.join(project.dir, 'package.json'), 'utf8'));
      if (packageJson.scripts && packageJson.scripts.build) {
        await execPromise('npm run build', project.dir);
      }
    }
    
    // Restart PM2
    await execPromise(`pm2 restart ${project.pm2Name}`, project.dir);
    
    console.log(`Deployment completed for ${projectName}`);
    return `Successfully deployed ${projectName}`;
    
  } catch (error) {
    console.error(`Deployment failed for ${projectName}:`, error);
    
    // Try to restart PM2 anyway to recover from partial failures
    try {
      await execPromise(`pm2 restart ${project.pm2Name}`, project.dir);
    } catch (restartError) {
      console.error(`Failed to restart PM2 after deployment failure:`, restartError);
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
app.listen(PORT, 'localhost', () => {
  console.log(`Deploy webhook server running on port ${PORT}`);
  console.log(`Configured projects: ${Object.keys(PROJECTS).join(', ')}`);
});
