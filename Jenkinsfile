pipeline {
  agent any

  environment {
    REGISTRY = credentials('docker-registry-url')
    REGISTRY_USER = credentials('docker-registry-user')
    REGISTRY_PASS = credentials('docker-registry-pass')
    IMAGE = "${REGISTRY}/ayo-snbt-backend"
    TAG = "${BUILD_NUMBER}-${GIT_COMMIT.take(8)}"
    SSH_HOST = credentials('vps-host')
    SSH_USER = credentials('vps-user')
    SSH_KEY = credentials('vps-ssh-key')
    APP_DIR = '/opt/ayo-snbt'
  }

  triggers {
    // Nightly load-test run (k6 scenarios against the staging stack)
    cron('H 2 * * *')
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Install') {
      steps {
        // Workspace-local npm cache for fast, reproducible installs
        sh 'npm ci --no-audit --no-fund --cache .npm-ci-cache'
      }
    }

    stage('Quality Gate') {
      parallel {
        stage('Lint') { steps { sh 'npm run lint' } }
        stage('Typecheck') { steps { sh 'npm run typecheck' } }
        stage('Unit Tests') { steps { sh 'npm test' } }
      }
    }

    stage('Integration Tests') {
      steps {
        sh 'docker compose -f compose.dev.yml up -d postgres pgbouncer redis mongo minio minio-init mailpit'
        sh 'npm run db:migrate'
        sh 'npm run db:seed'
        sh 'npm run test:integration'
        sh 'docker compose -f compose.dev.yml down'
      }
    }

    stage('Build') {
      steps { sh 'npm run build' }
    }

    stage('Docker Build & Scan') {
      steps {
        sh 'docker build -t ${IMAGE}:${TAG} .'
        sh 'docker tag ${IMAGE}:${TAG} ${IMAGE}:latest'
        // Block on CRITICAL vulnerabilities; HIGH is advisory (report only)
        sh 'trivy image --severity CRITICAL --exit-code 1 ${IMAGE}:${TAG}'
        sh 'trivy image --severity HIGH --format table --exit-code 0 ${IMAGE}:${TAG}'
      }
    }

    stage('Push') {
      steps {
        sh 'echo ${REGISTRY_PASS} | docker login ${REGISTRY} -u ${REGISTRY_USER} --password-stdin'
        sh 'docker push ${IMAGE}:${TAG}'
        sh 'docker push ${IMAGE}:latest'
      }
    }

    stage('Migrate (VPS)') {
      steps {
        // Run migrations against the production DB BEFORE app rollout
        sh 'ssh -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "cd ${APP_DIR} && docker compose run --rm api node dist/shared/db/migrate.js"'
      }
    }

    stage('Deploy (VPS)') {
      steps {
        sh 'ssh -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "cd ${APP_DIR} && docker compose pull && docker compose up -d"'
      }
    }

    stage('Smoke Test') {
      steps {
        sh 'sleep 10'
        sh 'curl -fsS http://${SSH_HOST}/health'
        sh 'curl -fsS http://${SSH_HOST}/ready'
        sh 'curl -fsS http://${SSH_HOST}/docs | head -c 200'
        sh 'curl -fsS http://${SSH_HOST}/metrics | head -c 200'
      }
    }

    stage('Nightly Load Test') {
      when { triggeredBy 'TimerTrigger' }
      steps {
        sh 'k6 run --summary-export=load/results.json load/catalog.js'
        sh 'k6 run load/authed.js'
        sh 'jq -e ".metrics.http_req_duration.p(99) < 100" load/results.json'
      }
    }
  }

  post {
    success {
      // Notify Slack/email: include build URL + commit + load-test summary
      echo 'BUILD SUCCEEDED — deploy complete'
    }
    failure {
      echo 'BUILD FAILED — check the stage logs'
    }
  }
}
