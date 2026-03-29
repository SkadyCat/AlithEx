const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const REPO_ROOT = path.resolve(APP_DIR, "..");
const WORKSPACE_ROOT = path.join(APP_DIR, "workspace");
const ROOT_WORKSPACE_NAME = path.basename(REPO_ROOT);
const TEMPLATE_WORKSPACE = "test";
const PORT = process.env.PORT || 7439;
const CARD_BUCKETS = ["drafts", "sessions", "inprocess", "processed"];
const DETAIL_BUCKETS = new Set(["drafts", "sessions", "inprocess", "processed", "doc"]);
const MODEL_PRESETS = ["claude-sonnet-4.6", "claude-opus-4", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];
const DEFAULT_MODEL = "gpt-5.4";

app.use(express.json({ limit: "1mb" }));
app.get("/dev", (_request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, "dev.html"));
});
app.use(express.static(PUBLIC_DIR));

function sanitizeWorkspaceName(input) {
  return String(input || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureSafeWorkspaceName(name) {
  const normalized = sanitizeWorkspaceName(name);
  if (!normalized) {
    const error = new Error("Workspace name is required.");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function ensureSafeFileName(fileName) {
  if (!fileName || fileName.includes("..") || /[\\/]/.test(fileName)) {
    const error = new Error("Invalid file name.");
    error.status = 400;
    throw error;
  }
  return fileName;
}

async function hasWorkspaceMarkers(dirPath) {
  const markerNames = ["sessions", "inprocess", "processed", "doc", "logs", "run.bat"];
  const markers = await Promise.all(
    markerNames.map(async (name) => {
      try {
        await fs.stat(path.join(dirPath, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    })
  );
  return markers.some(Boolean);
}

async function listWorkspaceNames() {
  let names = [];
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (await hasWorkspaceMarkers(REPO_ROOT) && !names.includes(ROOT_WORKSPACE_NAME)) {
    names.push(ROOT_WORKSPACE_NAME);
  }

  return names.sort((left, right) => left.localeCompare(right));
}

function getWorkspaceDir(workspace) {
  const normalized = ensureSafeWorkspaceName(workspace);
  if (normalized === ROOT_WORKSPACE_NAME) {
    return REPO_ROOT;
  }
  return path.join(WORKSPACE_ROOT, normalized);
}

function ensureWorkspaceDeletable(workspace) {
  const normalized = ensureSafeWorkspaceName(workspace);
  if (normalized === ROOT_WORKSPACE_NAME) {
    const error = new Error(`Workspace "${workspace}" cannot be deleted.`);
    error.status = 400;
    throw error;
  }
  if (normalized === TEMPLATE_WORKSPACE) {
    const error = new Error(`Workspace "${workspace}" is the template workspace and cannot be deleted.`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

async function ensureWorkspace(workspace) {
  const workspaceDir = getWorkspaceDir(workspace);
  try {
    const stats = await fs.stat(workspaceDir);
    if (!stats.isDirectory()) {
      throw new Error("Workspace path is not a directory.");
    }
    return workspaceDir;
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFound = new Error(`Workspace "${workspace}" was not found.`);
      notFound.status = 404;
      throw notFound;
    }
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function getWorkspaceConfigPath(workspaceDir) {
  return path.join(workspaceDir, "config.json");
}

function getCopilotConfigPath(workspaceDir) {
  return path.join(workspaceDir, ".copilot", "config.json");
}

function normalizeModel(value) {
  const model = String(value || "").trim();
  if (!model) {
    return "";
  }
  if (model.length > 100 || /[\r\n\t]/.test(model)) {
    const error = new Error("Invalid model value.");
    error.status = 400;
    throw error;
  }
  return model;
}

async function readWorkspaceConfig(workspaceDir) {
  const configPath = getWorkspaceConfigPath(workspaceDir);
  const content = await readTextIfExists(configPath);
  if (!content.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    const parseError = new Error(`Workspace config is invalid JSON: ${configPath}`);
    parseError.status = 500;
    throw parseError;
  }
}

async function readCopilotConfig(workspaceDir) {
  const configPath = getCopilotConfigPath(workspaceDir);
  const content = await readTextIfExists(configPath);
  if (!content.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    const parseError = new Error(`Copilot config is invalid JSON: ${configPath}`);
    parseError.status = 500;
    throw parseError;
  }
}

async function writeWorkspaceConfig(workspaceDir, updates) {
  const configPath = getWorkspaceConfigPath(workspaceDir);
  const currentConfig = await readWorkspaceConfig(workspaceDir);
  const nextConfig = {
    ...currentConfig,
    ...updates,
  };

  if (!nextConfig.model) {
    delete nextConfig.model;
  }

  await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return nextConfig;
}

async function readRunBatModel(workspaceDir) {
  const runBatPath = path.join(workspaceDir, "run.bat");
  const content = await readTextIfExists(runBatPath);
  const match = content.match(/--model=([^\s\r\n]+)/);
  return match ? normalizeModel(match[1]) : "";
}

async function resolveDefaultLauncherModel(workspaceDir) {
  const copilotConfig = await readCopilotConfig(workspaceDir);
  return normalizeModel(copilotConfig.model || "") || DEFAULT_MODEL;
}

async function resolveLauncherModel(workspaceDir, preferredModel = "") {
  if (preferredModel) {
    return preferredModel;
  }

  const runBatModel = await readRunBatModel(workspaceDir);
  if (runBatModel) {
    return runBatModel;
  }

  return resolveDefaultLauncherModel(workspaceDir);
}

function buildRunBatContent(model) {
  return [
    "@echo off",
    "setlocal EnableExtensions",
    "",
    "cd /d %~dp0",
    "",
    ":: 启动 copilot",
    `copilot --allow-all --model=${model}`,
    "",
    "endlocal",
    "",
  ].join("\n");
}

function buildExportLogBatContent(model) {
  return [
    "@echo off",
    "setlocal EnableExtensions",
    "",
    "cd /d %~dp0",
    "if not exist logs mkdir logs",
    "",
    'set "shell_log=logs\\copilot-shell.log"',
    "",
    "(",
    '    echo [INFO] Starting Copilot CLI with shell output redirected to "%shell_log%".',
    `    echo [INFO] Command line: copilot --allow-all --model=${model} --log-dir=logs --log-level=all %*`,
    `    copilot --allow-all --model=${model} --log-dir=logs --log-level=all %*`,
    ') > "%shell_log%" 2>&1',
    "",
    "endlocal",
    "",
  ].join("\n");
}

async function syncWorkspaceLaunchers(workspaceDir, preferredModel = "") {
  const model = preferredModel ? preferredModel : await resolveDefaultLauncherModel(workspaceDir);
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, "run.bat"), buildRunBatContent(model), "utf8"),
    fs.writeFile(path.join(workspaceDir, "export_log.bat"), buildExportLogBatContent(model), "utf8"),
  ]);
  return model;
}

function summarizeText(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 3).join(" ").slice(0, 180);
}

async function listCards(workspaceDir, bucketName) {
  const bucketDir = path.join(workspaceDir, bucketName);
  let entries = [];
  try {
    entries = await fs.readdir(bucketDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const cards = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const filePath = path.join(bucketDir, entry.name);
        const content = await readTextIfExists(filePath);
        const stats = await fs.stat(filePath);
        const stem = path.parse(entry.name).name;
        const linkedDocName = `${stem}_doc.md`;
        const linkedDocPath = path.join(workspaceDir, "doc", linkedDocName);
        let hasLinkedDoc = false;

        if (bucketName === "processed") {
          try {
            const docStats = await fs.stat(linkedDocPath);
            hasLinkedDoc = docStats.isFile();
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        }

        return {
          fileName: entry.name,
          title: entry.name,
          preview: summarizeText(content) || "(empty document)",
          updatedAt: stats.mtime.toISOString(),
          linkedDocName: hasLinkedDoc ? linkedDocName : "",
          hasLinkedDoc,
        };
      })
  );

  return cards;
}

async function listDocs(workspaceDir) {
  const docDir = path.join(workspaceDir, "doc");
  try {
    const entries = await fs.readdir(docDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLogTail(workspaceDir, maxLines = 200) {
  const logPath = path.join(workspaceDir, "logs", "agent-realtime.log");
  const content = await readTextIfExists(logPath);
  const lines = content.split(/\r?\n/).filter(Boolean);
  return {
    fileName: path.basename(logPath),
    lines: lines.slice(-maxLines),
  };
}

async function buildWorkspaceSummary(workspace) {
  const workspaceDir = await ensureWorkspace(workspace);
  const [drafts, sessions, inprocess, processed, docs, logs] = await Promise.all([
    listCards(workspaceDir, "drafts"),
    listCards(workspaceDir, "sessions"),
    listCards(workspaceDir, "inprocess"),
    listCards(workspaceDir, "processed"),
    listDocs(workspaceDir),
    readLogTail(workspaceDir),
  ]);

  return {
    workspace,
    buckets: {
      drafts,
      sessions,
      inprocess,
      processed,
    },
    docs,
    logs,
    settings: {
      model: await resolveLauncherModel(workspaceDir),
      presets: MODEL_PRESETS,
    },
  };
}

function getDetailPath(workspaceDir, bucket, fileName) {
  if (!DETAIL_BUCKETS.has(bucket)) {
    const error = new Error("Invalid bucket.");
    error.status = 400;
    throw error;
  }
  return path.join(workspaceDir, bucket, ensureSafeFileName(fileName));
}

async function deleteWorkspace(workspace) {
  const normalized = ensureWorkspaceDeletable(workspace);
  const workspaceDir = getWorkspaceDir(normalized);
  await fs.rm(workspaceDir, { recursive: true, force: false });
}

async function deleteWorkspaceItem(workspaceDir, bucket, fileName) {
  const itemPath = getDetailPath(workspaceDir, bucket, fileName);
  await fs.rm(itemPath, { force: false });

  let deletedLinkedDoc = "";
  if (bucket === "processed") {
    const stem = path.parse(fileName).name;
    const linkedDocName = `${stem}_doc.md`;
    const linkedDocPath = path.join(workspaceDir, "doc", linkedDocName);
    try {
      await fs.rm(linkedDocPath, { force: false });
      deletedLinkedDoc = linkedDocName;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    deleted: true,
    bucket,
    fileName,
    deletedLinkedDoc,
  };
}

function createTaskFileName() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `msg-${iso}.md`;
}

function createDraftFileName() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `draft-${iso}.md`;
}

app.get("/api/workspaces", async (_request, response, next) => {
  try {
    const workspaces = await listWorkspaceNames();
    const items = await Promise.all(
      workspaces.map(async (workspace) => {
        const summary = await buildWorkspaceSummary(workspace);
        return {
          name: workspace,
          counts: {
            drafts: summary.buckets.drafts.length,
            sessions: summary.buckets.sessions.length,
            inprocess: summary.buckets.inprocess.length,
            processed: summary.buckets.processed.length,
          },
        };
      })
    );
    response.json({ workspaces: items });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces", async (request, response, next) => {
  try {
    const name = ensureSafeWorkspaceName(request.body?.name);
    const templateDir = await ensureWorkspace(TEMPLATE_WORKSPACE);
    const targetDir = path.join(WORKSPACE_ROOT, name);
    const templateModel = await resolveLauncherModel(templateDir);

    try {
      await fs.stat(targetDir);
      const existsError = new Error(`Workspace "${name}" already exists.`);
      existsError.status = 409;
      throw existsError;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.cp(templateDir, targetDir, { recursive: true });

    // Clear runtime data from the template copy — keep the dirs, remove their contents.
    const CLEAR_DIRS = ["drafts", "sessions", "doc", "processed", "logs", "inprocess"];
    await Promise.all(
      CLEAR_DIRS.map(async (dirName) => {
        const dirPath = path.join(targetDir, dirName);
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          await Promise.all(
            entries.map((entry) =>
              fs.rm(path.join(dirPath, entry.name), { recursive: true, force: true })
            )
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          // dir didn't exist in template — create it fresh
          await fs.mkdir(dirPath, { recursive: true });
        }
      })
    );

    await syncWorkspaceLaunchers(targetDir, templateModel);

    response.status(201).json({
      created: true,
      workspace: name,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:workspace", async (request, response, next) => {
  try {
    await deleteWorkspace(request.params.workspace);
    response.json({
      deleted: true,
      workspace: request.params.workspace,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/:workspace/drafts", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const content = String(request.body?.content || "");
    const fileName = createDraftFileName();
    const draftDir = path.join(workspaceDir, "drafts");
    const draftPath = path.join(draftDir, fileName);
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(draftPath, content, "utf8");
    response.status(201).json({
      created: true,
      bucket: "drafts",
      fileName,
      content,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:workspace", async (request, response, next) => {
  try {
    const summary = await buildWorkspaceSummary(request.params.workspace);
    response.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:workspace/item", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const bucket = String(request.query.bucket || "");
    const fileName = String(request.query.file || "");
    const itemPath = getDetailPath(workspaceDir, bucket, fileName);
    const content = await fs.readFile(itemPath, "utf8");
    const stem = path.parse(fileName).name;
    const linkedDocName = bucket === "processed" ? `${stem}_doc.md` : "";
    const linkedDocContent = linkedDocName
      ? await readTextIfExists(path.join(workspaceDir, "doc", linkedDocName))
      : "";

    response.json({
      bucket,
      fileName,
      content,
      linkedDocName,
      linkedDocContent,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:workspace/item", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const bucket = String(request.query.bucket || "");
    const fileName = String(request.query.file || "");
    response.json(await deleteWorkspaceItem(workspaceDir, bucket, fileName));
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces/:workspace/item", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const bucket = String(request.query.bucket || "");
    const fileName = String(request.query.file || "");
    if (bucket !== "drafts") {
      const error = new Error("Only drafts can be edited.");
      error.status = 400;
      throw error;
    }

    const content = String(request.body?.content || "");
    const itemPath = getDetailPath(workspaceDir, bucket, fileName);
    await fs.mkdir(path.dirname(itemPath), { recursive: true });
    await fs.writeFile(itemPath, content, "utf8");
    response.json({
      saved: true,
      bucket,
      fileName,
      content,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/:workspace/drafts/:file/promote", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const sourceFileName = ensureSafeFileName(request.params.file);
    const sourcePath = path.join(workspaceDir, "drafts", sourceFileName);
    const content = await fs.readFile(sourcePath, "utf8");
    const targetFileName = createTaskFileName();
    const targetPath = path.join(workspaceDir, "sessions", targetFileName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    await fs.rm(sourcePath, { force: false });
    response.json({
      promoted: true,
      sourceBucket: "drafts",
      sourceFileName,
      targetBucket: "sessions",
      targetFileName,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:workspace/logs", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const tail = Number.parseInt(String(request.query.tail || "200"), 10);
    response.json(await readLogTail(workspaceDir, Number.isNaN(tail) ? 200 : tail));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/:workspace/tasks", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const content = String(request.body?.content || "").trim();
    if (!content) {
      const error = new Error("Task content cannot be empty.");
      error.status = 400;
      throw error;
    }

    const fileName = createTaskFileName();
    const taskPath = path.join(workspaceDir, "sessions", fileName);
    await fs.mkdir(path.dirname(taskPath), { recursive: true });
    await fs.writeFile(taskPath, `${content}\n`, "utf8");

    response.status(201).json({
      created: true,
      fileName,
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces/:workspace/settings", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const model = normalizeModel(request.body?.model);
    const launcherModel = await syncWorkspaceLaunchers(workspaceDir, model);

    response.json({
      saved: true,
      settings: {
        model: launcherModel,
        presets: MODEL_PRESETS,
      },
      launcherModel,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/:workspace/run-agent", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const model = normalizeModel(request.body?.model);
    const launcherModel = await syncWorkspaceLaunchers(workspaceDir, model);

    const launcherScript = path.join(APP_DIR, "launch-agent.py");
    await fs.access(launcherScript);

    const child = spawn("python", [launcherScript, request.params.workspace, launcherModel], {
      cwd: APP_DIR,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: false,
    });
    child.unref();

    response.json({
      started: true,
      workspace: request.params.workspace,
      model: launcherModel,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:workspace/search", async (request, response, next) => {
  try {
    const workspaceDir = await ensureWorkspace(request.params.workspace);
    const query = String(request.query.q || "").toLowerCase().trim();
    if (!query) {
      return response.json({ results: [], query: "" });
    }

    const searchBuckets = ["drafts", "sessions", "inprocess", "processed", "doc"];
    const allResults = [];

    for (const bucket of searchBuckets) {
      const bucketDir = path.join(workspaceDir, bucket);
      let entries = [];
      try {
        entries = await fs.readdir(bucketDir, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        continue;
      }

      const mdFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
      for (const entry of mdFiles) {
        const filePath = path.join(bucketDir, entry.name);
        const content = await readTextIfExists(filePath);
        if (content.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) {
          allResults.push({
            bucket,
            fileName: entry.name,
            preview: summarizeText(content),
          });
        }
      }
    }

    response.json({ results: allResults, query });
  } catch (error) {
    next(error);
  }
});

app.use((request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }
  response.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((error, _request, response, _next) => {
  const status = error.status || 500;
  response.status(status).json({
    error: error.message || "Unexpected server error.",
  });
});

app.listen(PORT, () => {
  console.log(`alith is running on http://localhost:${PORT}`);
});
