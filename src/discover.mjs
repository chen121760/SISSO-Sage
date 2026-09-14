import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function walk(directory) {
  const out = [];
  const stack = [path.resolve(directory)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function normalizedRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end >= start && end < start + length ? end : start + length).toString("utf8").trim();
}

export function readTarEntries(archiveFile) {
  const compressed = fs.readFileSync(archiveFile);
  const lower = archiveFile.toLowerCase();
  const buffer = lower.endsWith(".gz") || lower.endsWith(".tgz")
    ? zlib.gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 })
    : compressed;
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//, "");
    const sizeText = tarString(header, 124, 12).replace(/\0/g, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`Invalid TAR entry size for ${fullName || "unknown entry"}.`);
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    if (dataStart + size > buffer.length) throw new Error(`Truncated TAR entry: ${fullName || "unknown entry"}.`);
    if (type === "0" || type === "\0" || type === "") entries.push({ name: fullName, data: buffer.subarray(dataStart, dataStart + size) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function entryBase(name) {
  return name.replace(/\\/g, "/").split("/").pop();
}

function pickArchiveSingle(entries, basename, required) {
  const matches = entries.filter((entry) => entryBase(entry.name).toLowerCase() === basename.toLowerCase());
  matches.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  if (!matches.length && required) throw new Error(`Required SISSO file not found in archive: ${basename}`);
  return { entry: matches[0] || null, alternatives: matches.slice(1) };
}

function pickArchiveTop(entries, requested) {
  let tops = entries.filter((entry) => /^top\d+_D\d+$/i.test(entryBase(entry.name)));
  if (requested) {
    const wanted = String(requested).replace(/\\/g, "/").toLowerCase();
    tops = tops.filter((entry) => entry.name.toLowerCase() === wanted || entryBase(entry.name).toLowerCase() === entryBase(wanted).toLowerCase());
    if (!tops.length) throw new Error(`Requested ranked-model file was not found in archive: ${requested}`);
  }
  const lookup = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const pairs = tops.map((top) => {
    const coeff = lookup.get(`${top.name}_coeff`.toLowerCase());
    return coeff ? { top, coeff } : null;
  }).filter(Boolean);
  pairs.sort((a, b) => {
    const aa = topScore(a.top.name);
    const bb = topScore(b.top.name);
    return bb[0] - aa[0] || bb[1] - aa[1] || a.top.name.localeCompare(b.top.name);
  });
  if (!pairs.length) throw new Error("No matching Models/top*_D* and *_coeff file pair was found in the archive.");
  return { pair: pairs[0], alternatives: pairs.slice(1) };
}

function discoverArchive(archiveFile, options) {
  const archive = path.resolve(archiveFile);
  const entries = readTarEntries(archive);
  const train = pickArchiveSingle(entries, "train.dat", true);
  const embeddedVerify = pickArchiveSingle(entries, "verify.dat", false);
  const uspace = pickArchiveSingle(entries, "Uspace.expressions", true);
  const sissoIn = pickArchiveSingle(entries, "SISSO.in", false);
  const sissoOut = pickArchiveSingle(entries, "SISSO.out", false);
  const unitManifest = pickArchiveSingle(entries, "unit_manifest.txt", false);
  const sourceManifest = pickArchiveSingle(entries, "source_manifest.txt", false);
  const featureUnits = pickArchiveSingle(entries, "feature_units", false);
  const top = pickArchiveTop(entries, options.topFile);
  const externalVerify = options.verifyFile ? path.resolve(options.verifyFile) : null;
  if (externalVerify && !fs.existsSync(externalVerify)) throw new Error(`External verify file does not exist: ${externalVerify}`);
  const selectedEntries = {
    train: train.entry,
    verify: embeddedVerify.entry,
    uspace: uspace.entry,
    top: top.pair.top,
    coeff: top.pair.coeff,
    sissoIn: sissoIn.entry,
    sissoOut: sissoOut.entry,
    unitManifest: unitManifest.entry,
    sourceManifest: sourceManifest.entry,
    featureUnits: featureUnits.entry,
  };
  const warnings = [];
  if (externalVerify && embeddedVerify.entry) warnings.push("External --verify file overrides verify.dat embedded in the archive.");
  if (top.alternatives.length) warnings.push(`Multiple ranked-model pairs found; selected ${top.pair.top.name}.`);
  const text = (entry) => entry ? entry.data.toString("utf8") : undefined;
  return {
    kind: "archive",
    root: archive,
    selected: Object.fromEntries(Object.entries(selectedEntries).map(([key, entry]) => [key, entry?.name || null])),
    relative: Object.fromEntries(Object.entries(selectedEntries).map(([key, entry]) => [key, key === "verify" && externalVerify ? path.basename(externalVerify) : entry?.name || null])),
    warnings,
    healthFiles: {
      train: text(train.entry),
      verify: externalVerify ? fs.readFileSync(externalVerify, "utf8") : text(embeddedVerify.entry),
      top: text(top.pair.top),
      coeff: text(top.pair.coeff),
      uspace: text(uspace.entry),
      sissoIn: text(sissoIn.entry),
      sissoOut: text(sissoOut.entry),
    },
    auxiliary: {
      unitManifestText: text(unitManifest.entry),
      sourceManifestText: text(sourceManifest.entry),
      featureUnitsText: text(featureUnits.entry),
    },
  };
}

function pickSingle(files, basename, required) {
  const matches = files.filter((file) => path.basename(file).toLowerCase() === basename.toLowerCase());
  if (!matches.length && required) throw new Error(`Required SISSO file not found: ${basename}`);
  if (matches.length > 1) {
    matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }
  return { file: matches[0] || null, alternatives: matches.slice(1) };
}

function topScore(file) {
  const name = path.basename(file);
  const match = name.match(/^top(\d+)_D(\d+)$/i);
  return match ? [Number(match[2]), Number(match[1])] : [-1, -1];
}

function pickTopPair(files, requested) {
  const lookup = new Map(files.map((file) => [path.resolve(file).toLowerCase(), file]));
  let tops = files.filter((file) => /^top\d+_D\d+$/i.test(path.basename(file)));
  if (requested) {
    const resolved = path.resolve(requested);
    tops = tops.filter((file) => path.resolve(file).toLowerCase() === resolved.toLowerCase());
    if (!tops.length) throw new Error(`Requested ranked-model file was not found: ${requested}`);
  }
  const pairs = tops.map((top) => {
    const coeff = lookup.get(`${path.resolve(top)}_coeff`.toLowerCase());
    return coeff ? { top, coeff } : null;
  }).filter(Boolean);
  pairs.sort((a, b) => {
    const aa = topScore(a.top);
    const bb = topScore(b.top);
    return bb[0] - aa[0] || bb[1] - aa[1] || a.top.localeCompare(b.top);
  });
  if (!pairs.length) {
    throw new Error("No matching Models/top*_D* and *_coeff file pair was found.");
  }
  return { pair: pairs[0], alternatives: pairs.slice(1) };
}

function readMaybe(file) {
  return file ? fs.readFileSync(file, "utf8") : undefined;
}

export function discoverRun(directory, options = {}) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) throw new Error(`Run directory does not exist: ${root}`);
  if (fs.statSync(root).isFile()) {
    if (!/\.(?:tar|tar\.gz|tgz)$/i.test(root)) throw new Error(`Supported run inputs are directories, .tar, .tar.gz, and .tgz archives: ${root}`);
    return discoverArchive(root, options);
  }

  const files = walk(root);
  const train = pickSingle(files, "train.dat", true);
  const verify = pickSingle(files, "verify.dat", false);
  const uspace = pickSingle(files, "Uspace.expressions", true);
  const sissoIn = pickSingle(files, "SISSO.in", false);
  const sissoOut = pickSingle(files, "SISSO.out", false);
  const unitManifest = pickSingle(files, "unit_manifest.txt", false);
  const sourceManifest = pickSingle(files, "source_manifest.txt", false);
  const featureUnits = pickSingle(files, "feature_units", false);
  const top = pickTopPair(files, options.topFile);

  const selected = {
    train: train.file,
    verify: verify.file,
    uspace: uspace.file,
    top: top.pair.top,
    coeff: top.pair.coeff,
    sissoIn: sissoIn.file,
    sissoOut: sissoOut.file,
    unitManifest: unitManifest.file,
    sourceManifest: sourceManifest.file,
    featureUnits: featureUnits.file,
  };
  if (options.verifyFile) {
    const externalVerify = path.resolve(options.verifyFile);
    if (!fs.existsSync(externalVerify)) throw new Error(`External verify file does not exist: ${externalVerify}`);
    selected.verify = externalVerify;
  }
  const warnings = [];
  for (const [label, item] of Object.entries({ train, verify, uspace, sissoIn, sissoOut })) {
    if (item.alternatives.length) {
      warnings.push(`Multiple ${label} files found; selected ${normalizedRelative(root, item.file)}.`);
    }
  }
  if (top.alternatives.length) {
    warnings.push(`Multiple ranked-model pairs found; selected ${normalizedRelative(root, top.pair.top)}.`);
  }

  return {
    kind: "directory",
    root,
    selected,
    relative: Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, value ? normalizedRelative(root, value) : null])),
    warnings,
    healthFiles: {
      train: readMaybe(selected.train),
      verify: readMaybe(selected.verify),
      top: readMaybe(selected.top),
      coeff: readMaybe(selected.coeff),
      uspace: readMaybe(selected.uspace),
      sissoIn: readMaybe(selected.sissoIn),
      sissoOut: readMaybe(selected.sissoOut),
    },
    auxiliary: {
      unitManifestText: readMaybe(selected.unitManifest),
      sourceManifestText: readMaybe(selected.sourceManifest),
      featureUnitsText: readMaybe(selected.featureUnits),
    },
  };
}

export function pipelineFiles(discovery, dropVerify = false) {
  const raw = discovery.healthFiles;
  return {
    trainText: raw.train,
    verifyText: dropVerify ? undefined : raw.verify,
    topText: raw.top,
    coeffText: raw.coeff,
    uspaceText: raw.uspace,
    sissoInText: raw.sissoIn,
    sissoOutText: raw.sissoOut,
  };
}
