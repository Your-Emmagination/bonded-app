const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const hostsByRoom = new Map();

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("join-as-host", (roomId) => {
    hostsByRoom.set(roomId, socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    socket.to(roomId).emit("host-joined", { hostId: socket.id });
  });

  socket.on("join-as-viewer", (roomId) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "viewer";

    const hostId = hostsByRoom.get(roomId);
    if (hostId) {
      io.to(hostId).emit("viewer-joined", { viewerId: socket.id });
      socket.emit("host-joined", { hostId });
    } else {
      socket.emit("host-unavailable");
    }
  });

  socket.on("signal", ({ targetId, signal }) => {
    if (!targetId || !signal) {
      return;
    }

    io.to(targetId).emit("signal", {
      senderId: socket.id,
      signal,
    });
  });

  socket.on("disconnect", () => {
    if (socket.data.role === "host" && socket.data.roomId) {
      hostsByRoom.delete(socket.data.roomId);
      socket.to(socket.data.roomId).emit("host-left");
    }
  });
});

const port = Number(process.env.PORT || 5000);

server.listen(port, () => {
  console.log(`Signaling server running on port ${port}`);
});
