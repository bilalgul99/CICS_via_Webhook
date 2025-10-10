# 🚀 Staging Deployment Webhook Server

A lightweight, secure, and modular webhook server for deploying staging environments of client projects. Perfect for web development agencies that need to showcase progress to clients before final deployment.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)
![Express](https://img.shields.io/badge/Express-4.x-brightgreen)
![PM2](https://img.shields.io/badge/PM2-5.x-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Architecture](#-architecture)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Security](#-security)
- [GitHub Actions Setup](#-github-actions-setup)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## 🌟 Overview

This webhook server solves a common problem for web development agencies: **how to easily deploy and showcase client projects during development** when clients don't have their production servers ready yet.

The server listens for GitHub webhooks and automatically:
1. Pulls the latest code from the specified branch
2. Installs dependencies with `npm ci`
3. Builds the project (if a build script exists)
4. Restarts the PM2 process

Each project is configured independently with its own directory, PM2 name, webhook secret, and target branch.

## ✨ Features

- **Multi-project support**: Handle unlimited client projects with individual configurations
- **Secure webhooks**: GitHub signature verification prevents unauthorized deployments
- **Concurrent deployment protection**: File locking prevents race conditions
- **Automatic branch filtering**: Only deploy specified branches
- **Comprehensive error handling**: Graceful recovery from deployment failures
- **Health monitoring**: Built-in health check endpoint
- **Rate limiting**: Prevents abuse and DoS attacks
- **Detailed logging**: Full visibility into deployment processes
- **Easy project setup**: Simple configuration format

## 🏗️ Architecture

```
GitHub Repository
       │
       │ Webhook (POST)
       ▼
Deploy Webhook Server (Node.js + Express)
       │
       ├── Validates webhook signature
       ├── Checks project configuration
       ├── Acquires deployment lock
       │
       ▼
Project Directory (/var/www/project-name)
       │
       ├── git fetch --all
       ├── git reset --hard origin/branch
       ├── npm ci
       ├── npm run build (optional)
       │
       ▼
PM2 Process Manager
       │
       └── pm2 restart project-name
```

## 📋 Prerequisites

Before setting up, ensure you have:

- **Node.js** v18 or higher
- **npm** or **yarn**
- **PM2** installed globally (`npm install -g pm2`)
- **Git** installed and configured
- **Nginx** (recommended for SSL termination and reverse proxy)
- A **VPS** or dedicated server
- **Domain name** with SSL certificate (Let's Encrypt recommended)

## ⚙️ Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/staging-deploy-webhook.git
cd staging-deploy-webhook
```

### 2. Install dependencies

```bash
npm install express express-rate-limit
```

### 3. Create project directories

```bash
# Example structure
sudo mkdir -p /var/www/client-project-1
sudo mkdir -p /var/www/client-project-2
# Set proper permissions
sudo chown -R $USER:$USER /var/www/
```

### 4. Set up your projects

For each project, clone the repository and install dependencies:

```bash
cd /var/www/client-project-1
git clone https://github.com/your-org/client-project-1.git .
npm ci
# Test that it runs
npm start
```

### 5. Configure PM2 (optional but recommended)

Create an `ecosystem.config.js` in each project directory:

```javascript
// /var/www/client-project-1/ecosystem.config.js
module.exports = {
  apps: [{
    name: 'client-project-1',
    script: 'server.js', // or your main file
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'staging'
    }
  }]
};
```

Start your projects with PM2:

```bash
cd /var/www/client-project-1
pm2 start ecosystem.config.js
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in your webhook server directory:

```bash
# .env
PORT=8080
NODE_ENV=production

# JSON configuration for all projects
# Each project needs: dir, pm2Name, secret, and optionally branch
DEPLOY_PROJECTS='{
  "client-ecommerce": {
    "dir": "/var/www/client-ecommerce",
    "pm2Name": "client-ecommerce",
    "secret": "your-32-character-webhook-secret-here",
    "branch": "main"
  },
  "client-dashboard": {
    "dir": "/var/www/client-dashboard", 
    "pm2Name": "client-dashboard",
    "secret": "another-32-character-webhook-secret",
    "branch": "develop"
  }
}'
```

**Important**: Generate secure secrets using:

```bash
# Generate a secure 32-character hex secret
openssl rand -hex 32
```

### Nginx Configuration (Recommended)

Create `/etc/nginx/sites-available/deploy-webhook`:

```nginx
server {
    listen 80;
    server_name deploy.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name deploy.yourdomain.com;

    # SSL Configuration (use Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/deploy.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/deploy.yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Increase timeouts for deployments
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        send_timeout 600s;
    }

    # Optional: Basic authentication for extra security
    # auth_basic "Staging Deploy Webhook";
    # auth_basic_user_file /etc/nginx/.htpasswd;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/deploy-webhook /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### PM2 Ecosystem File

Create `ecosystem.config.js` for the webhook server:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'deploy-webhook',
    script: 'deploy-webhook.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
};
```

## ▶️ Usage

### Starting the Server

```bash
# Start with PM2 (recommended)
pm2 start ecosystem.config.js --env production

# Or start directly with Node.js
node deploy-webhook.js
```

### Adding New Projects

1. **Set up the project directory** as described in the Installation section
2. **Generate a new webhook secret**:
   ```bash
   openssl rand -hex 32
   ```
3. **Update the `DEPLOY_PROJECTS` environment variable** with the new project configuration
4. **Reload the webhook server**:
   ```bash
   pm2 reload deploy-webhook
   ```
5. **Configure the GitHub webhook** (see GitHub Actions Setup below)

### Endpoints

- **`POST /deploy/:projectName`** - Trigger deployment for a specific project
- **`GET /health`** - Health check endpoint showing configured projects

### Example Webhook Request

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=calculated-signature" \
  -d '{"ref":"refs/heads/main"}' \
  https://deploy.yourdomain.com/deploy/client-ecommerce
```

## 🔒 Security

### Webhook Signature Verification

The server validates GitHub webhook signatures using HMAC-SHA256 to ensure requests come from GitHub and haven't been tampered with.

### Rate Limiting

Built-in rate limiting prevents abuse:
- Maximum 10 requests per IP every 15 minutes
- Configurable in the source code

### Additional Security Recommendations

1. **Use HTTPS**: Always serve the webhook endpoint over HTTPS
2. **IP Whitelisting**: Configure Nginx to only accept requests from GitHub's IP ranges
3. **Basic Authentication**: Add HTTP basic auth as an additional layer
4. **Firewall Rules**: Restrict access to the webhook port
5. **Regular Updates**: Keep Node.js and dependencies updated

### GitHub IP Whitelisting (Nginx)

Add this to your Nginx configuration to only accept requests from GitHub:

```nginx
# GitHub webhook IP ranges (check https://api.github.com/meta for current ranges)
allow 192.30.252.0/22;
allow 185.199.108.0/22;
allow 140.82.112.0/20;
allow 143.55.64.0/20;
deny all;
```

## 🔄 GitHub Actions Setup

### 1. Create Workflow File

Create `.github/workflows/deploy-staging.yml` in your project repository:

```yaml
name: Deploy to Staging

on:
  push:
    branches: [ main, develop, staging ]  # Adjust based on your workflow
  # Uncomment for manual deployment triggers
  # workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging  # Optional: use GitHub environments
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v3
      
    - name: Deploy to staging server
      run: |
        curl -X POST \
          -H "Content-Type: application/json" \
          -H "X-Hub-Signature-256: ${{ secrets.WEBHOOK_SIGNATURE }}" \
          -d '{"ref":"refs/heads/${{ github.ref_name }}"}' \
          ${{ secrets.WEBHOOK_URL }}
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        
    - name: Verify deployment (optional)
      run: |
        echo "Waiting 15 seconds for deployment to complete..."
        sleep 15
        curl -f --retry 3 --retry-delay 5 https://${{ secrets.STAGING_DOMAIN }}/health || exit 1
```

### 2. Configure Repository Secrets

In your GitHub repository settings, add these secrets:

| Secret Name | Value |
|-------------|-------|
| `WEBHOOK_URL` | `https://deploy.yourdomain.com/deploy/your-project-name` |
| `WEBHOOK_SIGNATURE` | The secret you generated for this project |
| `STAGING_DOMAIN` | Your staging domain (e.g., `staging.client.com`) |

### 3. Set up GitHub Webhook (Alternative)

Instead of GitHub Actions, you can set up a traditional webhook:

1. Go to your repository **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: `https://deploy.yourdomain.com/deploy/your-project-name`
3. **Content type**: `application/json`
4. **Secret**: Your project's webhook secret
5. **Events**: Select "Just the push event"

## 🛠️ Troubleshooting

### Common Issues and Solutions

#### ❌ "Project not found" error
- **Cause**: Project name in URL doesn't match configuration
- **Solution**: Verify the project name in `DEPLOY_PROJECTS` matches the webhook URL

#### ❌ "Invalid signature" error
- **Cause**: Webhook secret mismatch
- **Solution**: Regenerate the secret and update both GitHub and your `.env` file

#### ❌ "Another deployment is in progress"
- **Cause**: Previous deployment is still running or lock wasn't released
- **Solution**: Wait a few minutes or restart the webhook server

#### ❌ PM2 restart fails
- **Cause**: PM2 process name doesn't match or process isn't running
- **Solution**: Verify the `pm2Name` in configuration matches your actual PM2 app name

### Debugging Commands

```bash
# Check PM2 processes
pm2 list

# View webhook server logs
pm2 logs deploy-webhook

# Test webhook manually
curl -v -X POST http://localhost:8080/health

# Check if project directory exists
ls -la /var/www/your-project-name

# Test deployment commands manually
cd /var/www/your-project-name
git fetch --all
git reset --hard origin/main
npm ci
pm2 restart your-pm2-name
```

### Log Files

- **Webhook server logs**: `~/.pm2/logs/deploy-webhook-out.log` and `~/.pm2/logs/deploy-webhook-error.log`
- **Nginx access logs**: `/var/log/nginx/deploy-webhook.access.log`
- **Nginx error logs**: `/var/log/nginx/deploy-webhook.error.log`

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built with ❤️ for web development agencies
- Inspired by the need for simple, secure staging deployments
- Uses battle-tested technologies: Node.js, Express, PM2, Nginx

---

**Made with ❤️ by your dunyaeamal mbilalgul**  
*Deploy confidently, ship faster!*
