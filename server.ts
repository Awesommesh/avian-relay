import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { nanoid } from 'nanoid';

const PORT = parseInt(process.env.PORT || '3001', 10);

// ============================================================
// Room management
// ============================================================

interface Room {
  code: string;
  hostSocket: Socket | null;
  guestSocket: Socket | null;
  createdAt: number;
}

const rooms = new Map<string, Room>();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function cleanupStaleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // Remove rooms older than 2 hours or both players disconnected for 60s+
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
    } else if (!room.hostSocket && !room.guestSocket && now - room.createdAt > 60_000) {
      rooms.delete(code);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupStaleRooms, 5 * 60 * 1000);

// ============================================================
// Server setup
// ============================================================

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow localhost and any LAN IP for development
      callback(null, true);
    },
    methods: ['GET', 'POST'],
  },
  pingInterval: 10_000,
  pingTimeout: 30_000,
});

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: process.uptime(),
  });
});

// ============================================================
// Socket.io connection handling
// ============================================================

io.on('connection', (socket: Socket) => {
  let currentRoom: string | null = null;
  let currentRole: 'host' | 'guest' | null = null;

  console.log(`[${socket.id}] Connected`);

  // Host creates a new room
  socket.on('create_room', () => {
    let code = generateRoomCode();
    while (rooms.has(code)) {
      code = generateRoomCode();
    }

    const room: Room = {
      code,
      hostSocket: socket,
      guestSocket: null,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    currentRoom = code;
    currentRole = 'host';

    socket.join(code);
    socket.emit('room_created', { roomCode: code });
    console.log(`[${socket.id}] Created room ${code}`);
  });

  // Guest joins an existing room
  socket.on('join_room', (data: { roomCode: string }) => {
    const code = data.roomCode.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join_error', { reason: 'Room not found' });
      return;
    }

    if (room.guestSocket) {
      socket.emit('join_error', { reason: 'Room is full' });
      return;
    }

    room.guestSocket = socket;
    currentRoom = code;
    currentRole = 'guest';

    socket.join(code);

    // Notify both players
    socket.emit('joined_room', { roomCode: code });
    room.hostSocket?.emit('player_joined', {});
    console.log(`[${socket.id}] Joined room ${code}`);
  });

  // Relay game messages between host and guest
  socket.on('game_message', (data: unknown) => {
    if (!currentRoom || !currentRole) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Forward to the other player
    if (currentRole === 'host' && room.guestSocket) {
      room.guestSocket.emit('game_message', data);
    } else if (currentRole === 'guest' && room.hostSocket) {
      room.hostSocket.emit('game_message', data);
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason: string) => {
    console.log(`[${socket.id}] Disconnected: ${reason}`);

    if (!currentRoom || !currentRole) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Clear the socket reference but keep the room alive for reconnection
    if (currentRole === 'host') {
      room.hostSocket = null;
      room.guestSocket?.emit('game_message', { type: 'opponent_disconnected' });
    } else {
      room.guestSocket = null;
      room.hostSocket?.emit('game_message', { type: 'opponent_disconnected' });
    }

    // Schedule room cleanup if both disconnected
    setTimeout(() => {
      const r = rooms.get(currentRoom!);
      if (r && !r.hostSocket && !r.guestSocket) {
        rooms.delete(currentRoom!);
        console.log(`Room ${currentRoom} cleaned up (both disconnected)`);
      }
    }, 60_000);
  });

  // Handle reconnection to existing room
  socket.on('rejoin_room', (data: { roomCode: string; role: 'host' | 'guest' }) => {
    const code = data.roomCode.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('rejoin_error', { reason: 'Room no longer exists' });
      return;
    }

    if (data.role === 'host' && !room.hostSocket) {
      room.hostSocket = socket;
      currentRoom = code;
      currentRole = 'host';
      socket.join(code);
      room.guestSocket?.emit('game_message', { type: 'opponent_reconnected' });
      socket.emit('rejoined_room', { roomCode: code });
      console.log(`[${socket.id}] Host rejoined room ${code}`);
    } else if (data.role === 'guest' && !room.guestSocket) {
      room.guestSocket = socket;
      currentRoom = code;
      currentRole = 'guest';
      socket.join(code);
      room.hostSocket?.emit('game_message', { type: 'opponent_reconnected' });
      socket.emit('rejoined_room', { roomCode: code });
      console.log(`[${socket.id}] Guest rejoined room ${code}`);
    } else {
      socket.emit('rejoin_error', { reason: 'Slot already occupied' });
    }
  });
});

// ============================================================
// Start server
// ============================================================

httpServer.listen(PORT, () => {
  console.log(`AvianAdian relay server running on http://localhost:${PORT}`);
});
