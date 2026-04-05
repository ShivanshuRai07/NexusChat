import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
const server = createServer(app);

app.use(cors());

// Basic health check for Render cold-start wakeups
app.get('/', (req, res) => res.send('NexusChat API is Online and Active.'));

// Limit buffers to 5MB to handle robust imaging data payloads internally over sockets
const io = new Server(server, {
  cors: {
    origin: ["https://nexushat.vercel.app", "https://nexuschat-sigma.vercel.app", "http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50e6
});

// VPN Tracker: socket.id -> { username, networkCode }
const connectedUsers = new Map();
const networkNames = new Map(); // networkCode -> networkName

// Helper to push refreshed Peer Lists to specific VPN networks
function broadcastPeerListToNetwork(networkCode) {
  const peers = [];
  for (const [id, user] of connectedUsers.entries()) {
    if (user.networkCode === networkCode) {
      peers.push({ id, username: user.username });
    }
  }
  // Multicast only to the specific subnet
  io.to(networkCode).emit('network:peers', peers);
}

io.on('connection', (socket) => {
  console.log(`[+] TCP Connection established. Socket ID: ${socket.id}`);

  // Admin Creates a new VPN Subnet
  socket.on('network:create', (payload) => {
    const { username, networkCode, networkName } = payload;
    if (!username || !networkCode) return;
    
    networkNames.set(networkCode, networkName || "Private Subnet");
    
    connectedUsers.set(socket.id, { username, networkCode });
    socket.join(networkCode);
    console.log(`[${networkCode}] ${username} CREATED and authenticated.`);

    socket.emit('network:success', { networkCode, networkName: networkNames.get(networkCode) });
    broadcastPeerListToNetwork(networkCode);
  });

  // User Authentication into a specific VLAN / Subnet
  socket.on('network:join', (payload) => {
    const { username, networkCode } = payload;
    if (!username || !networkCode) return;

    if (!networkNames.has(networkCode)) {
       socket.emit('network:error', "Unknown Subnet Passkey. Create a new Subnet instead.");
       return;
    }

    // Check if the user is switching from a different network
    const existingUser = connectedUsers.get(socket.id);
    if (existingUser && existingUser.networkCode !== networkCode) {
      const oldNet = existingUser.networkCode;
      socket.leave(oldNet);
      connectedUsers.set(socket.id, { username, networkCode });
      broadcastPeerListToNetwork(oldNet); // update old peers
    } else {
      connectedUsers.set(socket.id, { username, networkCode });
    }
    
    // Subscribe socket strictly to the new network pipeline
    socket.join(networkCode);
    console.log(`[${networkCode}] ${username} (${socket.id}) authenticated.`);

    // Signal successful handshake
    socket.emit('network:success', { networkCode, networkName: networkNames.get(networkCode) });

    // Sync state for all active nodes in the subnet
    broadcastPeerListToNetwork(networkCode);
  });

  // Direct 1-to-1 Targeted Packet Routing (Switch Behavior)
  socket.on('message:send', (payload) => {
    const { targetSocketId, text, attachments } = payload;
    const sender = connectedUsers.get(socket.id);
    
    // Reject unauthorized/anonymous packets
    if (!sender) return; 

    const packet = {
      senderId: socket.id,
      senderName: sender.username,
      text: text || "",
      attachments: attachments || [],
      timestamp: new Date().toISOString()
    };

    // Return receipt instantly back to originator for fast UI rendering
    socket.emit('message:receive', packet); 
    
    // Route exact data drop specifically to the targeted peer ID
    if (targetSocketId && targetSocketId !== socket.id) {
       io.to(targetSocketId).emit('message:receive', packet);
    }
  });

  socket.on('user:typing', (targetSocketId) => {
     if(targetSocketId) socket.to(targetSocketId).emit('user:typing', socket.id);
  });
  
  socket.on('user:stopTyping', (targetSocketId) => {
     if(targetSocketId) socket.to(targetSocketId).emit('user:stopTyping', socket.id);
  });

  // Automatically handle dropped connections and prune from subnet
  socket.on('disconnect', () => {
    console.log(`[-] Connection dropped. Socket ID: ${socket.id}`);
    const user = connectedUsers.get(socket.id);
    if (user) {
      const { networkCode } = user;
      connectedUsers.delete(socket.id);
      
      // Notify other live nodes in the sub-network that a node disconnected
      broadcastPeerListToNetwork(networkCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
// We listen on 0.0.0.0 to safely capture external network traffic (inter-device)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`> Nexus Network Switch initialized on 0.0.0.0:${PORT}`);
});
