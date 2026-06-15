import { createServer } from 'http';
import { Server } from 'socket.io';
import { app } from './app';
import { logger } from './utils/logger';

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Emit current system metrics immediately on connection
  socket.emit('metrics', {
    cpu: Math.floor(15 + Math.random() * 45),
    memory: Math.floor(40 + Math.random() * 15),
    network: Math.floor(100 + Math.random() * 900),
    disk: 54,
    timestamp: new Date().toISOString(),
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Periodically stream simulated metrics to all clients
setInterval(() => {
  const metrics = {
    cpu: Math.floor(15 + Math.random() * 45),
    memory: Math.floor(40 + Math.random() * 15),
    network: Math.floor(100 + Math.random() * 900),
    disk: 54,
    timestamp: new Date().toISOString(),
  };
  io.emit('metrics', metrics);
}, 2000);

httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
