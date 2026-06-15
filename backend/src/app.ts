import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
// express-mongo-sanitize removed since project uses SQLite
import cookieParser from 'cookie-parser';
import { logger } from './utils/logger';
import authRoutes from './routes/auth';
import deploymentRoutes from './routes/deployments';
import serviceRoutes from './routes/services';
import incidentRoutes from './routes/incidents';
export const app = express();
app.use(helmet());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use('/api', limiter);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  next();
});
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
app.use('/api/auth', authRoutes);
app.use('/api/deployments', deploymentRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/incidents', incidentRoutes);
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message,
    stack: err.stack
  });
});
