import { PrismaClient, Severity, ServiceState, DeploymentStatus, IncidentStatus, Role } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  console.log('Start seeding...');
  // Reset existing data
  await prisma.auditLog.deleteMany();
  await prisma.stage.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.deployment.deleteMany();
  await prisma.service.deleteMany();
  await prisma.metric.deleteMany();
  await prisma.user.deleteMany();
  // 1. Create User
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@pulsara.dev',
      name: 'DevOps Lead',
      passwordHash: 'hashed_password_placeholder',
      role: Role.ADMIN,
    },
  });
  // 2. Create Services
  const services = await Promise.all([
    prisma.service.create({
      data: { name: 'API Gateway', status: ServiceState.ONLINE, uptime: 99.99, responseTime: 45 },
    }),
    prisma.service.create({
      data: { name: 'Auth Service', status: ServiceState.ONLINE, uptime: 100, responseTime: 12 },
    }),
    prisma.service.create({
      data: { name: 'Payment Processor', status: ServiceState.ONLINE, uptime: 99.95, responseTime: 150 },
    }),
    prisma.service.create({
      data: { name: 'Background Workers', status: ServiceState.DEGRADED, uptime: 98.2, responseTime: 450 },
    }),
    prisma.service.create({
      data: { name: 'Primary DB', status: ServiceState.ONLINE, uptime: 99.99, responseTime: 5 },
    }),
    prisma.service.create({
      data: { name: 'Redis Cache', status: ServiceState.ONLINE, uptime: 100, responseTime: 1 },
    }),
  ]);
  // 3. Create Deployments & Stages
  for (let i = 0; i < 5; i++) {
    const isSuccess = Math.random() > 0.3;
    const isRunning = i === 0 && Math.random() > 0.5;
    
    let status: DeploymentStatus = DeploymentStatus.SUCCESS;
    if (isRunning) status = DeploymentStatus.RUNNING;
    else if (!isSuccess) status = DeploymentStatus.FAILED;
    const deployment = await prisma.deployment.create({
      data: {
        repo: i % 2 === 0 ? 'pulsara-frontend' : 'pulsara-backend',
        branch: i === 0 ? 'main' : (i === 1 ? 'feature/payment-integration' : 'hotfix/api-latency'),
        status: status,
        duration: status === DeploymentStatus.RUNNING ? null : Math.floor(Math.random() * 200) + 120, // 2-5 mins
        userId: adminUser.id,
        createdAt: new Date(Date.now() - i * 3600000 * 2), // Past few hours
      },
    });
    // Create 3 stages for each deployment
    const stageNames = ['Build', 'Test', 'Deploy'];
    for (let j = 0; j < 3; j++) {
      let stageStatus: DeploymentStatus = DeploymentStatus.SUCCESS;
      let stageDuration: number | null = Math.floor(Math.random() * 60) + 20;
      if (status === DeploymentStatus.FAILED && j === 2) {
         stageStatus = DeploymentStatus.FAILED;
      } else if (status === DeploymentStatus.RUNNING && j === 2) {
         stageStatus = DeploymentStatus.RUNNING;
         stageDuration = null;
      } else if (status === DeploymentStatus.RUNNING && j > 2) {
         stageStatus = DeploymentStatus.PENDING;
         stageDuration = null;
      }
      await prisma.stage.create({
        data: {
          name: stageNames[j],
          status: stageStatus,
          duration: stageDuration,
          deploymentId: deployment.id,
          logs: stageStatus === DeploymentStatus.FAILED ? 'Error: Integration test failed.' : 'Success: Stage completed.',
        },
      });
    }
  }
  // 4. Create Incidents
  await prisma.incident.create({
    data: {
      title: 'High latency on Background Workers',
      description: 'The background worker queue is backing up and causing timeouts.',
      severity: Severity.MEDIUM,
      status: IncidentStatus.INVESTIGATING,
      serviceId: services[3].id,
      assigneeId: adminUser.id,
    },
  });
  await prisma.incident.create({
    data: {
      title: 'Database connection drop',
      description: 'Primary database cluster lost connection for 5 minutes during routine backup.',
      severity: Severity.HIGH,
      status: IncidentStatus.RESOLVED,
      serviceId: services[4].id,
      assigneeId: adminUser.id,
      createdAt: new Date(Date.now() - 86400000), // 1 day ago
    },
  });
  console.log('Seeding finished.');
}
main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
