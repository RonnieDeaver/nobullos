/* test-registration
{
  "name": "NoBull Docs — DOCX import & export round-trip (Task #4024)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4024/#4052: the .docx bridge in/out of NoBull Docs. Covers the converter round-trip (export a snapshot to .docx, re-import it, text/styling survive), real table import (Univer table tokens + tableSource) with docx round-trip, inline image import/export round-trip, unsupported-drawing reporting, malformed-buffer rejection, and the HTTP surface (multipart import happy path, 415 wrong file type, 422 corrupt file, export headers + PK zip magic, 422 export of an empty document). A regression here strands users' documents in or out of the app.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Docs — DOCX import/export tests (Task #4024).
 *
 * Unit-tests the two converters directly, then exercises the import/export
 * HTTP routes end-to-end (multipart upload → stored document → download).
 */

// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Clerk test seam (server/middlewares/requireAuth.ts): a string authenticates
// as that user id. The owner is seeded in an isolated schema (uncommitted to
// public), so it is pre-registered via __test_markUserReconciled — requireAuth
// then populates req.user/req.dbUser from that profile.
function makeAuthMiddleware(userId: string, _role: string) {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = userId;
    next();
  };
}

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

async function startServer(app: express.Express): Promise<void> {
  originalDispatcher = getGlobalDispatcher();
  currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(currentAgent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (currentAgent) {
    try {
      await currentAgent.close();
    } catch {
      /* ignore */
    }
    currentAgent = null;
  }
}

let passed = 0;
let failed = 0;
function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Build a small but representative Univer document snapshot:
 * a heading-styled paragraph, a bold+italic run, and a plain paragraph.
 * Layout mirrors what UniverDocEditor produces (dataStream + textRuns +
 * paragraphs, \r paragraph marks, trailing \r\n section end).
 */
function richSnapshot() {
  const heading = "Quarterly Report";
  const body = "Revenue grew fast this quarter.";
  const tail = "Closing remarks.";
  // dataStream: heading \r body \r tail \r\n
  const dataStream = `${heading}\r${body}\r${tail}\r\n`;
  const bodyStart = heading.length + 1;
  return {
    id: `d-${randomUUID().slice(0, 8)}`,
    body: {
      dataStream,
      textRuns: [
        // "Revenue grew" bold, "fast" italic.
        { st: bodyStart, ed: bodyStart + 12, ts: { bl: 1 } },
        { st: bodyStart + 18, ed: bodyStart + 22, ts: { it: 1 } },
      ],
      paragraphs: [
        // namedStyleType is Univer's numeric NamedStyleType enum: 4 = HEADING_1.
        { startIndex: heading.length, paragraphStyle: { namedStyleType: 4 } },
        { startIndex: heading.length + 1 + body.length },
        { startIndex: heading.length + 1 + body.length + 1 + tail.length },
      ],
      sectionBreaks: [{ startIndex: dataStream.length - 1 }],
    },
    documentStyle: { pageSize: { width: 595, height: 842 } },
  };
}

async function run() {
  const { convertDocumentSnapshotToDocx } = await import("../server/services/docsExportConverter");
  const { convertDocxToDocumentSnapshot } = await import("../server/services/docsImportConverter");

  // ---- converter unit tests (no DB) ----

  let roundTripDocx: Buffer;
  {
    roundTripDocx = await convertDocumentSnapshotToDocx(richSnapshot(), "Quarterly Report");
    assert.ok(Buffer.isBuffer(roundTripDocx) && roundTripDocx.length > 500, "export produced a buffer");
    assert.equal(roundTripDocx[0], 0x50, "PK magic byte 1");
    assert.equal(roundTripDocx[1], 0x4b, "PK magic byte 2");
    ok("export produces a valid .docx (PK zip) buffer");

    const { snapshot, report } = await convertDocxToDocumentSnapshot(roundTripDocx, "Quarterly Report");
    const stream: string = snapshot.body.dataStream;
    assert.ok(stream.includes("Quarterly Report"), "heading text survived");
    assert.ok(stream.includes("Revenue grew fast this quarter."), "body text survived");
    assert.ok(stream.includes("Closing remarks."), "tail text survived");
    ok("round-trip preserves all paragraph text");

    const boldRun = (snapshot.body.textRuns ?? []).find((r: any) => r.ts?.bl === 1);
    const italicRun = (snapshot.body.textRuns ?? []).find((r: any) => r.ts?.it === 1);
    assert.ok(boldRun, "a bold text run survived the round-trip");
    assert.ok(italicRun, "an italic text run survived the round-trip");
    const boldText = stream.slice(boldRun.st, boldRun.ed);
    assert.ok(boldText.includes("Revenue grew"), `bold run covers the bold text, got: ${JSON.stringify(boldText)}`);
    ok("bold/italic styling survives the round-trip");

    const headingPara = (snapshot.body.paragraphs ?? []).find(
      (p: any) => p.paragraphStyle?.namedStyleType === 4, // NamedStyleType.HEADING_1
    );
    assert.ok(headingPara, "HEADING_1 named style survived the round-trip");
    assert.ok(report.paragraphCount >= 3, `report counts paragraphs (${report.paragraphCount})`);
    ok("heading style + report paragraph count are correct");
  }

  // Real table import: build a .docx containing a table via the docx pkg,
  // import it, and verify Univer table structure (not flattened text).
  {
    const docx = await import("docx");
    const table = new docx.Table({
      rows: [
        new docx.TableRow({
          children: [
            new docx.TableCell({ children: [new docx.Paragraph("Cell A1")] }),
            new docx.TableCell({ children: [new docx.Paragraph("Cell B1")] }),
          ],
        }),
        new docx.TableRow({
          children: [
            new docx.TableCell({ children: [new docx.Paragraph("Cell A2")] }),
            new docx.TableCell({ children: [new docx.Paragraph("Cell B2")] }),
          ],
        }),
      ],
    });
    const doc = new docx.Document({
      sections: [{ children: [new docx.Paragraph("Before table"), table, new docx.Paragraph("After table")] }],
    });
    const buf = Buffer.from(await docx.Packer.toBuffer(doc));

    const { snapshot, report } = await convertDocxToDocumentSnapshot(buf, "With Table");
    const stream: string = snapshot.body.dataStream;
    assert.ok(stream.includes("Before table") && stream.includes("After table"), "surrounding text kept");

    // Univer table tokens: \x1A table, \x1B row, \x1C/\x1D cell, \x0E row end, \x0F table end.
    assert.ok(stream.includes("\u001A") && stream.includes("\u000F"), "table start/end tokens present");
    assert.equal((stream.match(/\u001B/g) ?? []).length, 2, "two table rows");
    assert.equal((stream.match(/\u001C/g) ?? []).length, 4, "four table cells");
    assert.ok(
      stream.includes("\u001CCell A1\r\n\u001D"),
      `cell A1 is a real cell body, got: ${JSON.stringify(stream)}`,
    );
    assert.ok(!stream.includes("Cell A1\tCell B1"), "table is NOT flattened to tab-joined text");

    const tables: any[] = snapshot.body.tables;
    assert.ok(Array.isArray(tables) && tables.length === 1, "body.tables has one entry");
    assert.equal(stream[tables[0].startIndex], "\u001A", "tables.startIndex points at table start");
    assert.equal(stream[tables[0].endIndex - 1], "\u000F", "tables.endIndex covers table end");

    const source: any = (snapshot as any).tableSource?.[tables[0].tableId];
    assert.ok(source, "tableSource entry exists for the tableId");
    assert.equal(source.tableRows.length, 2, "tableSource has 2 rows");
    assert.equal(source.tableColumns.length, 2, "tableSource has 2 columns");
    assert.equal(source.tableRows[0].tableCells.length, 2, "row has 2 cells");

    assert.equal(report.tableCount, 1, "report counts the table");
    assert.ok(
      !report.entries.some((e: any) => e.type === "table_flattened"),
      "no table_flattened entry — tables import for real now",
    );
    ok("tables import as real Univer tables with tableSource");

    // Round-trip: export the imported snapshot back to .docx and re-import.
    const exported = await convertDocumentSnapshotToDocx(snapshot, "With Table");
    const { snapshot: again } = await convertDocxToDocumentSnapshot(exported, "With Table again");
    const stream2: string = again.body.dataStream;
    assert.ok(stream2.includes("\u001CCell A1\r\n\u001D"), "table survives export → re-import");
    assert.equal((stream2.match(/\u001B/g) ?? []).length, 2, "row count survives round-trip");
    assert.ok(Array.isArray(again.body.tables) && again.body.tables.length === 1, "tables meta survives");
    ok("tables round-trip through export and back");
  }

  // Column spans: a 3-column table where row 1 has a gridSpan=2 cell must
  // still produce a full grid — covered placeholder cells (rowSpan/columnSpan
  // 0) pad every row to the declared column count, matching Univer's own
  // HTML-table importer output.
  {
    const docx = await import("docx");
    const table = new docx.Table({
      rows: [
        new docx.TableRow({
          children: [
            new docx.TableCell({ columnSpan: 2, children: [new docx.Paragraph("Wide head")] }),
            new docx.TableCell({ children: [new docx.Paragraph("C1")] }),
          ],
        }),
        new docx.TableRow({
          children: [
            new docx.TableCell({ children: [new docx.Paragraph("A2")] }),
            new docx.TableCell({ children: [new docx.Paragraph("B2")] }),
            new docx.TableCell({ children: [new docx.Paragraph("C2")] }),
          ],
        }),
      ],
    });
    const doc = new docx.Document({ sections: [{ children: [table] }] });
    const buf = Buffer.from(await docx.Packer.toBuffer(doc));

    const { snapshot } = await convertDocxToDocumentSnapshot(buf, "Span Table");
    const stream: string = snapshot.body.dataStream;
    assert.equal((stream.match(/\u001B/g) ?? []).length, 2, "two rows");
    assert.equal((stream.match(/\u001C/g) ?? []).length, 6, "every row has 3 grid cells (covered padded)");

    const tableId = snapshot.body.tables[0].tableId;
    const source: any = (snapshot as any).tableSource[tableId];
    assert.equal(source.tableColumns.length, 3, "3 declared columns");
    const row1: any[] = source.tableRows[0].tableCells;
    assert.equal(row1.length, 3, "row 1 has 3 tableCells entries");
    assert.equal(row1[0].columnSpan, 2, "spanning cell keeps columnSpan 2");
    assert.equal(row1[1].rowSpan, 0, "covered cell rowSpan 0");
    assert.equal(row1[1].columnSpan, 0, "covered cell columnSpan 0");
    assert.equal(source.tableRows[1].tableCells.length, 3, "row 2 has 3 cells");
    assert.ok(!("columnSpan" in (source.tableRows[1].tableCells[0] ?? {})) || source.tableRows[1].tableCells[0].columnSpan === undefined, "plain cell has no span");

    // Univer's own document model accepts the snapshot (grid is coherent).
    // DocumentDataModel is used via @univerjs/presets — a declared dependency
    // that publicly re-exports the @univerjs/core API. @univerjs/core itself
    // is NOT declared at the root, only hoisted, so importing it directly
    // would break on a presets-family hoisting change (audit R-09, Task #4148).
    const { DocumentDataModel } = await import("@univerjs/presets");
    const model = new DocumentDataModel(snapshot as any);
    assert.equal(model.getBody()?.tables?.length, 1, "DocumentDataModel parses the table");
    ok("column spans import with covered placeholder cells (valid Univer grid)");

    // Round-trip: export honors the span (covered cells skipped, gridSpan
    // written), so re-import reproduces the same grid.
    const exported = await convertDocumentSnapshotToDocx(snapshot, "Span Table");
    const { snapshot: again } = await convertDocxToDocumentSnapshot(exported, "Span again");
    const src2: any = (again as any).tableSource[again.body.tables[0].tableId];
    assert.equal(src2.tableColumns.length, 3, "3 columns after round-trip");
    assert.equal(src2.tableRows[0].tableCells[0].columnSpan, 2, "columnSpan survives round-trip");
    assert.equal(src2.tableRows[0].tableCells[1].rowSpan, 0, "covered cell survives round-trip");
    assert.ok(again.body.dataStream.includes("Wide head") && again.body.dataStream.includes("C2"), "cell text survives");
    ok("column spans round-trip through export and back");
  }

  // Inline image import: a .docx with an embedded PNG becomes a Univer
  // custom-block drawing (BASE64 data URL), and round-trips through export.
  {
    const docx = await import("docx");
    // Minimal valid 1x1 red PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const doc = new docx.Document({
      sections: [{
        children: [
          new docx.Paragraph("Screenshot below:"),
          new docx.Paragraph({
            children: [new docx.ImageRun({
              type: "png",
              data: png,
              transformation: { width: 120, height: 80 },
            })],
          }),
        ],
      }],
    });
    const buf = Buffer.from(await docx.Packer.toBuffer(doc));

    const { snapshot, report } = await convertDocxToDocumentSnapshot(buf, "With Image");
    const stream: string = snapshot.body.dataStream;
    assert.ok(stream.includes("Screenshot below:"), "text kept");
    assert.ok(stream.includes("\b"), "custom-block char present for the image");

    const customBlocks: any[] = snapshot.body.customBlocks;
    assert.ok(Array.isArray(customBlocks) && customBlocks.length === 1, "one custom block");
    const drawing = (snapshot as any).drawings?.[customBlocks[0].blockId];
    assert.ok(drawing, "drawing registered under the blockId");
    assert.ok(
      typeof drawing.source === "string" && drawing.source.startsWith("data:image/png;base64,"),
      "drawing source is a BASE64 png data URL",
    );
    assert.ok(drawing.docTransform?.size?.width > 0, "drawing has a size");
    assert.deepEqual((snapshot as any).drawingsOrder, [customBlocks[0].blockId], "drawingsOrder set");
    assert.equal(report.imagesImported, 1, "report counts the imported image");
    assert.equal(report.imagesSkipped, 0, "nothing skipped");
    assert.ok(
      !report.entries.some((e: any) => e.type === "image_skipped"),
      "no image_skipped entry for a supported picture",
    );
    ok("embedded PNG imports as a real inline image drawing");

    // Round-trip: export embeds the image; re-import finds it again.
    const exported = await convertDocumentSnapshotToDocx(snapshot, "With Image");
    const { snapshot: again, report: report2 } = await convertDocxToDocumentSnapshot(exported, "Again");
    assert.equal(report2.imagesImported, 1, "image survives export → re-import");
    const cb2: any[] = again.body.customBlocks;
    const drawing2 = (again as any).drawings?.[cb2[0].blockId];
    assert.ok(drawing2?.source?.startsWith("data:image/png;base64,"), "re-imported image is BASE64 png");
    ok("images round-trip through export and back");
  }

  // Malformed buffer rejects.
  {
    await assert.rejects(
      () => convertDocxToDocumentSnapshot(Buffer.from("definitely not a zip file"), "Broken"),
      /docx|zip|invalid|corrupt|parse/i,
      "malformed buffer rejects with a parse error",
    );
    ok("malformed .docx buffer rejects loudly");
  }

  // ---- HTTP routes (isolated schema, getDb pinned for the Express async
  // context so route handlers hit the cloned docs tables) ----

  await runInIsolatedSchema(async ({ db }) => {
    const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const ownerId = `docsie-owner-${RUN}`;

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'docsie_owner', 'docsie_owner_${RUN}@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );
    // Seeded in an isolated schema (uncommitted to public); pre-register so
    // requireAuth uses the profile directly instead of JIT-provisioning.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      email: `docsie_owner_${RUN}@test.local`,
      firstName: "docsie_owner",
      role: "account_manager",
    });

    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.use(makeAuthMiddleware(ownerId, "account_manager"));
    const { registerDocsRoutes } = await import("../server/routes/docs");
    registerDocsRoutes(app);
    await startServer(app);

    try {
      // Import happy path (multipart).
      let importedId = "";
      {
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(roundTripDocx)], { type: DOCX_MIME }), "quarterly.docx");
        fd.append("name", "Imported Quarterly");
        const res = await fetch(`${baseUrl}/api/docs/documents/import`, { method: "POST", body: fd });
        const body: any = await res.json();
        assert.equal(res.status, 201, `import: ${JSON.stringify(body)}`);
        assert.equal(body.document.name, "Imported Quarterly");
        assert.ok(body.report, "import returns the conversion report");
        importedId = body.document.id;
        ok("multipart .docx import returns 201 with document + report");

        // Stored document is immediately editable (snapshot persisted).
        const get = await fetch(`${baseUrl}/api/docs/documents/${importedId}`);
        const gotBody: any = await get.json();
        assert.ok(
          JSON.stringify(gotBody.document.snapshot).includes("Revenue grew fast this quarter."),
          "imported snapshot persisted",
        );
        ok("imported document content is persisted and re-readable");
      }

      // Wrong file type → 415.
      {
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(Buffer.from("plain text"))], { type: "text/plain" }), "notes.txt");
        const res = await fetch(`${baseUrl}/api/docs/documents/import`, { method: "POST", body: fd });
        assert.equal(res.status, 415, `txt import: ${res.status}`);
        ok("non-.docx upload → 415");
      }

      // Corrupt .docx-named payload → 422.
      {
        const fd = new FormData();
        fd.append(
          "file",
          new Blob([new Uint8Array(Buffer.from("garbage bytes, not a zip"))], { type: DOCX_MIME }),
          "corrupt.docx",
        );
        const res = await fetch(`${baseUrl}/api/docs/documents/import`, { method: "POST", body: fd });
        assert.equal(res.status, 422, `corrupt import: ${res.status}`);
        ok("corrupt .docx payload → 422");
      }

      // Export: headers + magic bytes + re-importable content.
      {
        const res = await fetch(`${baseUrl}/api/docs/documents/${importedId}/export/docx`);
        assert.equal(res.status, 200, `export status ${res.status}`);
        assert.ok(
          (res.headers.get("content-type") ?? "").includes("wordprocessingml.document"),
          `content-type: ${res.headers.get("content-type")}`,
        );
        assert.ok(
          (res.headers.get("content-disposition") ?? "").includes("attachment"),
          "content-disposition is an attachment",
        );
        const buf = Buffer.from(await res.arrayBuffer());
        assert.ok(buf.length > 500 && buf[0] === 0x50 && buf[1] === 0x4b, "export body is a PK zip");

        const { convertDocxToDocumentSnapshot: reimport } = await import(
          "../server/services/docsImportConverter"
        );
        const { snapshot } = await reimport(buf, "re-import");
        assert.ok(
          snapshot.body.dataStream.includes("Revenue grew fast this quarter."),
          "exported file re-imports with content intact",
        );
        ok("export download round-trips back through import");
      }

      // Empty document export → 422.
      {
        const createRes = await fetch(`${baseUrl}/api/docs/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Empty doc" }),
        });
        const created: any = await createRes.json();
        const res = await fetch(`${baseUrl}/api/docs/documents/${created.document.id}/export/docx`);
        assert.equal(res.status, 422, `empty export: ${res.status}`);
        ok("exporting an empty document → 422");
        await fetch(`${baseUrl}/api/docs/documents/${created.document.id}`, { method: "DELETE" });
      }
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
      await db.execute(`DELETE FROM doc_documents WHERE owner_id = '${ownerId}'` as any);
      await db.execute(`DELETE FROM users WHERE id = '${ownerId}'` as any);
    }
  }, {
    tables: [
      "users",
      "doc_documents",
      "doc_document_locks",
      "doc_document_versions",
      "doc_document_activity",
    ],
    pinGetDbForCrossAsync: true,
  });

  console.log(`\nNoBull Docs import/export: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("docs-import-export test crashed:", err);
  process.exit(1);
});
