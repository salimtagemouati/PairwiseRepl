import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { projects, sessions, sessionParticipants } from "@shared/schema";
import { db } from "./db";

export function createAuthenticator(config: string | undefined) {
  const digests = new Map<string, Buffer>();
  for (const [id, digest] of Object.entries(JSON.parse(config || "{}"))) {
    if (!id || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Invalid PAIRWISE_ACCESS_DIGESTS configuration");
    }
    digests.set(id, Buffer.from(digest, "hex"));
  }
  return (header: string | undefined) => {
    if (!header?.startsWith("Basic ")) return;
    const value = Buffer.from(header.slice(6), "base64").toString();
    const separator = value.indexOf(":");
    if (separator < 1) return;
    const id = value.slice(0, separator);
    const expected = digests.get(id);
    const actual = createHash("sha256").update(value.slice(separator + 1)).digest();
    if (expected && timingSafeEqual(expected, actual)) return id;
  };
}

export function visibleSessions(user: string, write = false) {
  const participants = db.select({ id: sessionParticipants.id }).from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessions.id),
      eq(sessionParticipants.userId, user), isNull(sessionParticipants.leftAt),
      write ? inArray(sessionParticipants.role, ["editor", "driver", "navigator"]) : undefined));
  return or(eq(sessions.hostId, user), exists(participants));
}

export async function sessionAccess(user: string, id: string, write = false, hostOnly = false) {
  const [row] = await db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.id, id), hostOnly ? eq(sessions.hostId, user) : visibleSessions(user, write)));
  return Boolean(row);
}

export async function projectAccess(user: string, id: string, write: boolean, ownerOnly = false) {
  const shared = db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.projectId, projects.id), visibleSessions(user, write)));
  const [row] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, id), or(eq(projects.ownerId, user), ownerOnly ? undefined : exists(shared))));
  return Boolean(row);
}
