import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import WebSocket from "ws";

test("workspace access through HTTP and WebSocket", async t => {
  process.env.DATABASE_URL = "postgresql://unused.invalid/test";
  const ids = ["host", "editor", "observer", "outside"];
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString("hex")]));
  process.env.PAIRWISE_ACCESS_DIGESTS = JSON.stringify(Object.fromEntries(ids.map(id =>
    [id, createHash("sha256").update(tokens[id]).digest("hex")])));
  const { pool } = await import("../server/db.ts");
  const { registerRoutes } = await import("../server/routes.ts");
  const pg = new PGlite();
  t.after(() => pg.close());
  pool.query = async (query, params) => pg.query(query.text, params, { rowMode: query.rowMode });
  await pg.exec(`
    create table users(id text primary key, username text, avatar_url text);
    create table sessions(id text primary key, project_id text, host_id text, title text,
      description text, status text, started_at timestamp, ended_at timestamp, created_at timestamp);
    create table session_participants(id text, session_id text, user_id text, role text, left_at timestamp);
    create table projects(id text, owner_id text);
    create table files(id text, project_id text, path text, content text, created_at timestamp, updated_at timestamp);
    create table snapshots(id text, session_id text, author_id text, timestamp timestamp, description text, diff jsonb, base_snapshot_id text);
    create table inline_comments(id text, session_id text);
    insert into sessions(id, host_id, project_id) values ('team','host','project');
    insert into projects values ('project','host');
    insert into files(id, project_id) values ('file','project');
    insert into snapshots(id,session_id) values ('snapshot','team');
    insert into inline_comments values ('comment','team');
    insert into session_participants values ('1','team','editor','editor',null), ('2','team','observer','observer',null);
  `);
  const app = express();
  app.use(express.json());
  const server = await registerRoutes(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = process.env.PAIRWISE_ORIGIN = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const auth = id => 'Basic ' + Buffer.from(id + ':' + tokens[id]).toString('base64');
  const request = (id, path, method = "GET", body) => fetch(origin + "/api/" + path,
    { method, headers: { authorization: auth(id), "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin + "/api/sessions")).status, 401);
  assert.deepEqual(await (await request("outside", "sessions")).json(), []);
  for (const [path, method] of [["sessions/team","GET"],["sessions/team/comments","POST"],
    ["snapshots/snapshot","GET"], ["comments/comment/status","PATCH"], ["projects/project/files","GET"],
    ["files/file","DELETE"]]) assert.equal((await request("outside", path, method, method === "GET" ? undefined : {})).status, 404);
  assert.equal((await request("observer", "files/file", "PATCH", {content:"no"})).status, 404);
  assert.equal((await request("editor", "sessions/team/status", "PATCH", {status:"live"})).status, 404);
  assert.equal((await request("editor", "files/file", "PATCH", {content:"saved"})).status, 200);
  assert.equal((await request("observer", "projects/project/files")).status, 200);
  const connect = (id, site = origin) => new WebSocket(origin.replace("http", "ws") + "/ws?session=team",
    {origin: site, headers:{ authorization:auth(id) }});
  await assert.rejects(once(connect("outside"), "open"));
  await assert.rejects(once(connect("host", "https://other.invalid"), "open"));
  const host = connect("host");
  await once(host, "open");
  const editor = connect("editor");
  await once(editor, "open");
  try {
    const edit = new Promise(resolve => host.on("message", raw => {
      const msg = JSON.parse(raw);
      if (msg.type === "editor-change") resolve(msg);
    }));
    editor.send(JSON.stringify({type:"editor-change", filePath:"a.ts", code:"saved", userId:"outside"}));
    assert.equal((await edit).userId, "editor");
    await pg.exec("update session_participants set left_at = now() where user_id = 'editor'");
    const closed = once(editor,"close");
    host.send(JSON.stringify({type:"editor-change", filePath:"a.ts", code:"updated"}));
    assert.equal((await closed)[0], 1008);
    assert.equal((await request("editor", "sessions/team")).status, 404);
  } finally { host.terminate(); editor.terminate(); }
});
