import { createAuthenticator, projectAccess, sessionAccess, visibleSessions } from "./access";
import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { insertSessionSchema, insertSnapshotSchema, insertInlineCommentSchema, insertFileSchema, insertProjectSchema } from "@shared/schema";
import { db } from "./db";
import { users, sessions, snapshots, inlineComments, sessionParticipants, files } from "@shared/schema";
import { eq, desc, count } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  const authenticate = createAuthenticator(process.env.PAIRWISE_ACCESS_DIGESTS);
  app.use((req, res, next) => {
    const user = authenticate(req.headers.authorization);
    if (!user) {
      res.set("WWW-Authenticate", 'Basic realm="PairwiseRepl"');
      return res.sendStatus(401);
    }
    res.locals.user = user;
    res.set("Cache-Control", "private, no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        (req.headers["sec-fetch-site"] === "cross-site" ||
         (req.headers.origin && req.headers.origin !== process.env.PAIRWISE_ORIGIN))) {
      return res.sendStatus(403);
    }
    next();
  });
  app.get("/api/me", (_req, res) => res.json({ id: res.locals.user }));
  app.use("/api/sessions/:id", async (req, res, next) => {
    try {
      if (!await sessionAccess(res.locals.user, req.params.id, req.method !== "GET", req.method === "PATCH")) {
        return res.sendStatus(404);
      }
      next();
    } catch { res.sendStatus(503); }
  });

  app.get("/api/sessions", async (req, res) => {
    try {
      const allSessions = await db
        .select({
          id: sessions.id,
          projectId: sessions.projectId,
          hostId: sessions.hostId,
          title: sessions.title,
          description: sessions.description,
          status: sessions.status,
          startedAt: sessions.startedAt,
          endedAt: sessions.endedAt,
          createdAt: sessions.createdAt,
          host: {
            id: users.id,
            username: users.username,
            avatarUrl: users.avatarUrl,
          },
        })
        .from(sessions)
        .leftJoin(users, eq(sessions.hostId, users.id))
        .where(visibleSessions(res.locals.user))
        .orderBy(desc(sessions.createdAt));

      const sessionsWithCounts = await Promise.all(
        allSessions.map(async (session) => {
          const [participantCount] = await db
            .select({ count: count() })
            .from(sessionParticipants)
            .where(eq(sessionParticipants.sessionId, session.id));

          return {
            ...session,
            _count: {
              participants: participantCount?.count || 0,
            },
          };
        })
      );

      res.json(sessionsWithCounts);
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const [sessionData] = await db
        .select({
          id: sessions.id,
          projectId: sessions.projectId,
          hostId: sessions.hostId,
          title: sessions.title,
          description: sessions.description,
          status: sessions.status,
          startedAt: sessions.startedAt,
          endedAt: sessions.endedAt,
          createdAt: sessions.createdAt,
          host: {
            id: users.id,
            username: users.username,
            avatarUrl: users.avatarUrl,
          },
        })
        .from(sessions)
        .leftJoin(users, eq(sessions.hostId, users.id))
        .where(eq(sessions.id, sessionId));

      if (!sessionData) {
        return res.status(404).json({ error: "Session not found" });
      }

      res.json({ ...sessionData, canEdit: await sessionAccess(res.locals.user, sessionId, true) });
    } catch (error) {
      console.error("Error fetching session:", error);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    try {
      const validatedData = insertSessionSchema.parse({ ...req.body, hostId: res.locals.user });
      if (validatedData.projectId && !await projectAccess(res.locals.user, validatedData.projectId, true, true)) return res.sendStatus(404);
      const session = await storage.createSession(validatedData);
      res.status(201).json(session);
    } catch (error: any) {
      console.error("Error creating session:", error);
      res.status(400).json({ error: error.message || "Failed to create session" });
    }
  });

  app.patch("/api/sessions/:id/status", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { status } = req.body;
      
      if (!["scheduled", "live", "finished", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      await storage.updateSessionStatus(sessionId, status);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating session status:", error);
      res.status(500).json({ error: "Failed to update session status" });
    }
  });

  app.get("/api/sessions/:id/snapshots", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const snapshotsData = await db
        .select({
          id: snapshots.id,
          sessionId: snapshots.sessionId,
          authorId: snapshots.authorId,
          timestamp: snapshots.timestamp,
          description: snapshots.description,
          diff: snapshots.diff,
          baseSnapshotId: snapshots.baseSnapshotId,
          author: {
            id: users.id,
            username: users.username,
            avatarUrl: users.avatarUrl,
          },
        })
        .from(snapshots)
        .leftJoin(users, eq(snapshots.authorId, users.id))
        .where(eq(snapshots.sessionId, sessionId))
        .orderBy(snapshots.timestamp);

      const snapshotsWithCounts = await Promise.all(
        snapshotsData.map(async (snapshot) => {
          const [commentCount] = await db
            .select({ count: count() })
            .from(inlineComments)
            .where(eq(inlineComments.snapshotId, snapshot.id));

          return {
            ...snapshot,
            _count: {
              comments: commentCount?.count || 0,
            },
          };
        })
      );

      res.json(snapshotsWithCounts);
    } catch (error) {
      console.error("Error fetching snapshots:", error);
      res.status(500).json({ error: "Failed to fetch snapshots" });
    }
  });

  app.post("/api/sessions/:id/snapshots", async (req, res) => {
    try {
      const sessionId = req.params.id;
      
      // Extract files from request body
      const filesData = req.body.diff?.files || {};
      
      if (Array.isArray(filesData) || typeof filesData !== "object" ||
          Object.keys(filesData).length === 0 ||
          Object.entries(filesData).some(([path, value]) => !path || typeof value !== "string")) {
        return res.status(400).json({ error: "A snapshot requires at least one named file with text content" });
      }

      // Get most recent snapshot for diff calculation
      const previousSnapshots = await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.sessionId, sessionId))
        .orderBy(desc(snapshots.timestamp))
        .limit(1);
      
      const filesModified = Object.keys(filesData);
      let linesChanged = 0;
      
      if (previousSnapshots.length > 0) {
        // Calculate diff against previous snapshot
        const prevDiff = previousSnapshots[0].diff as any;
        const prevFiles = prevDiff?.files || {};
        
        // Compare current files with previous snapshot
        for (const [path, content] of Object.entries(filesData)) {
          const currentLines = (content as string).split('\n').length;
          const prevContent = prevFiles[path] || '';
          const prevLines = typeof prevContent === 'string' ? prevContent.split('\n').length : 0;
          linesChanged += Math.abs(currentLines - prevLines);
        }
        
        // Add lines from files that were removed
        for (const [path, content] of Object.entries(prevFiles)) {
          if (!filesData[path]) {
            const prevLines = typeof content === 'string' ? (content as string).split('\n').length : 0;
            linesChanged += prevLines;
          }
        }
      } else {
        // First snapshot: all lines are "added"
        linesChanged = Object.values(filesData).reduce((sum: number, content: any) => {
          return sum + (typeof content === 'string' ? content.split('\n').length : 0);
        }, 0);
      }
      
      const metadata = {
        linesChanged, // Diff delta against previous snapshot (or total if first)
        filesModified,
      };
      
      // Normalize snapshot format
      const normalizedDiff = {
        files: filesData,
        metadata,
      };
      
      const validatedData = insertSnapshotSchema.parse({
        description: req.body.description,
        authorId: res.locals.user,
        sessionId,
        diff: normalizedDiff,
      });
      
      const snapshot = await storage.createSnapshot(validatedData);
      
      // Broadcast snapshot-created event via WebSocket
      if (activeConnections.has(sessionId)) {
        broadcast(sessionId, {
          type: 'snapshot-created',
          snapshotId: snapshot.id,
          sessionId,
          timestamp: snapshot.timestamp,
          author: res.locals.user,
          description: snapshot.description,
          metadata,
        });
      }
      
      res.status(201).json(snapshot);
    } catch (error: any) {
      console.error("Error creating snapshot:", error);
      res.status(400).json({ error: error.message || "Failed to create snapshot" });
    }
  });

  app.get("/api/snapshots/:id", async (req, res) => {
    try {
      const snapshotId = req.params.id;
      const [snapshot] = await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.id, snapshotId));
      
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      
      if (!await sessionAccess(res.locals.user, snapshot.sessionId)) return res.sendStatus(404);
      res.json(snapshot);
    } catch (error) {
      console.error("Error fetching snapshot:", error);
      res.status(500).json({ error: "Failed to fetch snapshot" });
    }
  });

  app.get("/api/sessions/:id/comments", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const commentsData = await db
        .select({
          id: inlineComments.id,
          sessionId: inlineComments.sessionId,
          snapshotId: inlineComments.snapshotId,
          filePath: inlineComments.filePath,
          range: inlineComments.range,
          authorId: inlineComments.authorId,
          text: inlineComments.text,
          status: inlineComments.status,
          createdAt: inlineComments.createdAt,
          updatedAt: inlineComments.updatedAt,
          author: {
            id: users.id,
            username: users.username,
            email: users.email,
            avatarUrl: users.avatarUrl,
          },
        })
        .from(inlineComments)
        .leftJoin(users, eq(inlineComments.authorId, users.id))
        .where(eq(inlineComments.sessionId, sessionId))
        .orderBy(inlineComments.createdAt);

      res.json(commentsData);
    } catch (error) {
      console.error("Error fetching comments:", error);
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/sessions/:id/comments", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const [target] = await db.select({ sessionId: snapshots.sessionId }).from(snapshots).where(eq(snapshots.id, req.body.snapshotId));
      if (target?.sessionId !== sessionId) return res.sendStatus(404);
      const validatedData = insertInlineCommentSchema.parse({
        ...req.body,
        authorId: res.locals.user,
        sessionId,
      });
      const comment = await storage.createComment(validatedData);
      res.status(201).json(comment);
    } catch (error: any) {
      console.error("Error creating comment:", error);
      res.status(400).json({ error: error.message || "Failed to create comment" });
    }
  });

  app.patch("/api/comments/:id/status", async (req, res) => {
    try {
      const commentId = req.params.id;
      const [comment] = await db.select({ sessionId: inlineComments.sessionId }).from(inlineComments).where(eq(inlineComments.id, commentId));
      if (!comment || !await sessionAccess(res.locals.user, comment.sessionId, true)) return res.sendStatus(404);
      const { status } = req.body;
      
      if (!["open", "resolved", "closed"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      await storage.updateCommentStatus(commentId, status);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating comment status:", error);
      res.status(500).json({ error: "Failed to update comment status" });
    }
  });

  app.get("/api/sessions/:id/participants", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const participantsData = await db
        .select({
          id: sessionParticipants.id,
          sessionId: sessionParticipants.sessionId,
          userId: sessionParticipants.userId,
          role: sessionParticipants.role,
          joinedAt: sessionParticipants.joinedAt,
          leftAt: sessionParticipants.leftAt,
          user: {
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            email: users.email,
            avatarUrl: users.avatarUrl,
            bio: users.bio,
            createdAt: users.createdAt,
            lastSeen: users.lastSeen,
          },
        })
        .from(sessionParticipants)
        .leftJoin(users, eq(sessionParticipants.userId, users.id))
        .where(eq(sessionParticipants.sessionId, sessionId));

      const participants = participantsData.map((p) => ({
        id: p.id,
        role: p.role,
        user: p.user!,
        isOnline: p.leftAt === null,
      }));

      res.json(participants);
    } catch (error) {
      console.error("Error fetching participants:", error);
      res.status(500).json({ error: "Failed to fetch participants" });
    }
  });

  app.get("/api/projects/:id/files", async (req, res) => {
    try {
      const projectId = req.params.id;
      if (!await projectAccess(res.locals.user, projectId, false)) return res.sendStatus(404);
      const files = await storage.getFilesByProjectId(projectId);
      res.json(files);
    } catch (error) {
      console.error("Error fetching files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  });

  app.post("/api/projects/:projectId/files", async (req, res) => {
    try {
      const projectId = req.params.projectId;
      if (!await projectAccess(res.locals.user, projectId, true)) return res.sendStatus(404);
      const validatedData = insertFileSchema.parse({
        ...req.body,
        projectId,
      });
      const file = await storage.createFile(validatedData);
      res.status(201).json(file);
    } catch (error: any) {
      console.error("Error creating file:", error);
      res.status(400).json({ error: error.message || "Failed to create file" });
    }
  });

  app.patch("/api/files/:id", async (req, res) => {
    try {
      const fileId = req.params.id;
      const file = await storage.getFile(fileId);
      if (!file || !await projectAccess(res.locals.user, file.projectId, true)) return res.sendStatus(404);
      const { content } = req.body;
      
      if (content === undefined) {
        return res.status(400).json({ error: "Content is required" });
      }

      await storage.updateFileContent(fileId, content);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating file:", error);
      res.status(500).json({ error: "Failed to update file" });
    }
  });

  app.delete("/api/files/:id", async (req, res) => {
    try {
      const fileId = req.params.id;
      const file = await storage.getFile(fileId);
      if (!file || !await projectAccess(res.locals.user, file.projectId, true)) return res.sendStatus(404);
      await db.delete(files).where(eq(files.id, fileId));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting file:", error);
      res.status(500).json({ error: "Failed to delete file" });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const activeConnections = new Map<string, Set<WebSocket>>();
  const identities = new WeakMap<WebSocket, string>();
  httpServer.on("upgrade", async (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url || "/", "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/ws") return;
    const id = url.searchParams.get("session");
    const user = authenticate(req.headers.authorization);
    try {
      if (!id || !user || !process.env.PAIRWISE_ORIGIN ||
          req.headers.origin !== process.env.PAIRWISE_ORIGIN || !await sessionAccess(user, id)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        identities.set(ws, user);
        const peers = activeConnections.get(id) ?? new Set<WebSocket>();
        activeConnections.set(id, peers);
        peers.add(ws);
        void broadcast(id, { type: "participant-joined", userId: user }, ws);
        ws.on("error", () => ws.terminate());
        ws.on("close", () => {
          peers.delete(ws);
          if (!peers.size) activeConnections.delete(id);
          void broadcast(id, { type: "participant-left", userId: user }, ws);
        });
        ws.on("message", async data => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === "leave-session") return ws.close();
            const edit = message.type === "editor-change";
            if (!edit && message.type !== "cursor-move") return;
            if (!await sessionAccess(user, id, edit)) return ws.close(1008);
            if (typeof message.filePath !== "string" || (edit && typeof message.code !== "string")) return;
            await broadcast(id, { type: message.type, userId: user, filePath: message.filePath,
              ...(edit ? { code: message.code } : { position: message.position }), timestamp: Date.now() }, ws);
          } catch { ws.close(1008); }
        });
      });
    } catch { socket.destroy(); }
  });

  async function broadcast(id: string, message: unknown, exclude?: WebSocket) {
    const payload = JSON.stringify(message);
    await Promise.all(Array.from(activeConnections.get(id) ?? [], async peer => {
      if (peer === exclude) return;
      try {
        if (!await sessionAccess(identities.get(peer)!, id)) return peer.close(1008);
        if (peer.readyState === WebSocket.OPEN) peer.send(payload);
      } catch { peer.terminate(); }
    }));
  }

  return httpServer;
}
