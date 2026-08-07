import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultCoordinationDataRoots = [
  resolve(repositoryRoot, "..", "data"),
  resolve(repositoryRoot, "..", "..", "..", "data"),
];
const requestedCoordinationDataRoot = process.env.ARENA_DATA_ROOT
  ? resolve(process.env.ARENA_DATA_ROOT)
  : defaultCoordinationDataRoots.find((candidate) => existsSync(join(candidate, "schema")))
    ?? defaultCoordinationDataRoots[0];
const bundledSharedDataRoot = join(
  repositoryRoot,
  "packages",
  "arena-agent",
  "test",
  "fixtures",
  "shared-data",
);
const coordinationSchemaDirectory = join(requestedCoordinationDataRoot, "schema");
const bundledSharedSchemaDirectory = join(bundledSharedDataRoot, "schema");
const coordinationSchemasAvailable = existsSync(coordinationSchemaDirectory);
if (process.env.ARENA_DATA_ROOT && !coordinationSchemasAvailable) {
  throw new Error(`ARENA_DATA_ROOT does not contain schema/: ${requestedCoordinationDataRoot}`);
}
const sharedDataRoot = coordinationSchemasAvailable ? requestedCoordinationDataRoot : bundledSharedDataRoot;
const sharedSchemaDirectory = join(sharedDataRoot, "schema");
const sharedFixtureDirectory = join(sharedSchemaDirectory, "fixtures");
const calibrationSchemaName = "sim-calibration-case-v1";
const calibrationSchemaId = "https://arena.local/schemas/sim-calibration-case-v1.schema.json";
const localCalibrationSchemaPath = join(
  repositoryRoot,
  "packages",
  "arena-agent",
  "src",
  "sim",
  "calibration",
  "sim-calibration-case-v1.schema.json",
);
const typeScriptFixtureDirectory = join(
  repositoryRoot,
  "packages",
  "arena-agent",
  "test",
  "fixtures",
  "sim",
);
const schemaNameToId = new Map([
  [calibrationSchemaName, calibrationSchemaId],
  ["sim-record-v1", "https://arena.local/schemas/sim-record-v1.schema.json"],
  ["ml-sample-v1", "https://arena.local/schemas/ml-sample-v1.schema.json"],
  ["dataset-manifest-v1", "https://arena.local/schemas/dataset-manifest-v1.schema.json"],
  ["dataset-registry-entry-v1", "https://arena.local/schemas/dataset-registry-entry-v1.schema.json"],
]);

function isDateTime(value) {
  const dateTimePattern = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
  return dateTimePattern.test(value) && Number.isFinite(Date.parse(value));
}

function isUriReference(value) {
  if (/[\u0000-\u0020\u007f]/u.test(value) || /%(?![0-9a-fA-F]{2})/u.test(value)) {
    return false;
  }
  try {
    new URL(value, "https://arena.local/");
    return true;
  } catch {
    return false;
  }
}

function createValidator() {
  const validator = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  validator.addFormat("date-time", { type: "string", validate: isDateTime });
  validator.addFormat("uri-reference", { type: "string", validate: isUriReference });
  return validator;
}

async function listFilesRecursively(directoryPath) {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    directoryEntries.map(async (directoryEntry) => {
      const entryPath = join(directoryPath, directoryEntry.name);
      return directoryEntry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
    }),
  );
  return nestedFiles.flat().sort();
}

async function readJson(filePath) {
  const fileContents = await readFile(filePath, "utf8");
  try {
    return JSON.parse(fileContents);
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, filePath)} is not valid JSON`, { cause: error });
  }
}

function formatValidationErrors(validationErrors) {
  return (validationErrors ?? [])
    .map((validationError) => {
      const instancePath = validationError.instancePath || "/";
      return `${instancePath} ${validationError.message ?? "is invalid"}`;
    })
    .join("; ");
}

function validateInstance(validator, schemaId, instance, filePath) {
  const validate = validator.getSchema(schemaId);
  assert.ok(validate, `schema was not registered: ${schemaId}`);
  if (!validate(instance)) {
    throw new Error(
      `${relative(repositoryRoot, filePath)} failed ${schemaId}: ${formatValidationErrors(validate.errors)}`,
    );
  }
}

async function registerSharedSchemas(validator) {
  const schemaPaths = (await readdir(sharedSchemaDirectory))
    .filter((fileName) => fileName.endsWith(".schema.json"))
    .sort()
    .map((fileName) => join(sharedSchemaDirectory, fileName));
  assert.equal(schemaPaths.length, schemaNameToId.size, "expected exactly five shared schemas");

  const registeredSchemaIds = new Set();
  for (const schemaPath of schemaPaths) {
    const schema = await readJson(schemaPath);
    assert.equal(typeof schema.$id, "string", `${schemaPath} must declare $id`);
    assert.ok(!registeredSchemaIds.has(schema.$id), `duplicate schema $id: ${schema.$id}`);
    if (!validator.validateSchema(schema)) {
      throw new Error(
        `${relative(repositoryRoot, schemaPath)} failed the 2020-12 metaschema: `
          + formatValidationErrors(validator.errors),
      );
    }
    validator.addSchema(schema, schema.$id);
    registeredSchemaIds.add(schema.$id);
  }

  for (const expectedSchemaId of schemaNameToId.values()) {
    assert.ok(registeredSchemaIds.has(expectedSchemaId), `missing shared schema $id: ${expectedSchemaId}`);
    assert.ok(validator.getSchema(expectedSchemaId), `could not compile shared schema: ${expectedSchemaId}`);
  }
  return schemaPaths.length;
}

async function validateSharedFixtures(validator) {
  const fixturePaths = (await listFilesRecursively(sharedFixtureDirectory))
    .filter((filePath) => filePath.endsWith(".json"));
  assert.ok(fixturePaths.length >= schemaNameToId.size, "expected a valid fixture for every shared schema");

  const coveredSchemaNames = new Set();
  const fixturesBySchemaName = new Map();
  for (const fixturePath of fixturePaths) {
    const fixture = await readJson(fixturePath);
    const schemaId = schemaNameToId.get(fixture.schema);
    assert.ok(schemaId, `${fixturePath} has an unknown schema discriminator`);
    validateInstance(validator, schemaId, fixture, fixturePath);
    coveredSchemaNames.add(fixture.schema);
    fixturesBySchemaName.set(fixture.schema, fixture);
  }
  assert.deepEqual(coveredSchemaNames, new Set(schemaNameToId.keys()));

  const simRecordFixture = fixturesBySchemaName.get("sim-record-v1");
  const invalidConclusiveRecord = { ...simRecordFixture, semanticStatus: "conclusive" };
  const validateSimRecord = validator.getSchema(schemaNameToId.get("sim-record-v1"));
  assert.ok(validateSimRecord);
  assert.equal(
    validateSimRecord(invalidConclusiveRecord),
    false,
    "sim-record-v1 must reject conclusive records with material unknowns",
  );
  return fixturePaths.length;
}

async function validateTypeScriptCalibrationFixtures(validator) {
  const fixturePaths = (await listFilesRecursively(typeScriptFixtureDirectory))
    .filter((filePath) => filePath.endsWith(".json"));
  let validatedFixtureCount = 0;
  for (const fixturePath of fixturePaths) {
    const fixture = await readJson(fixturePath);
    if (fixture.schema !== calibrationSchemaName) {
      continue;
    }
    validateInstance(validator, calibrationSchemaId, fixture, fixturePath);
    validatedFixtureCount += 1;
  }
  assert.ok(validatedFixtureCount > 0, "no TypeScript calibration fixtures were found");
  return validatedFixtureCount;
}

async function verifyBundledSharedDataMirror() {
  if (!coordinationSchemasAvailable) {
    return;
  }

  const externalSchemaFiles = (await readdir(coordinationSchemaDirectory))
    .filter((fileName) => fileName.endsWith(".schema.json"))
    .sort();
  const bundledSchemaFiles = (await readdir(bundledSharedSchemaDirectory))
    .filter((fileName) => fileName.endsWith(".schema.json"))
    .sort();
  assert.deepEqual(
    bundledSchemaFiles,
    externalSchemaFiles,
    "bundled CI schema mirror must contain exactly the external shared schemas",
  );
  for (const fileName of externalSchemaFiles) {
    const [externalBytes, bundledBytes] = await Promise.all([
      readFile(join(coordinationSchemaDirectory, fileName)),
      readFile(join(bundledSharedSchemaDirectory, fileName)),
    ]);
    assert.ok(
      externalBytes.equals(bundledBytes),
      `bundled CI schema mirror drift: ${fileName}`,
    );
  }

  const externalFixtureDirectory = join(coordinationSchemaDirectory, "fixtures");
  const bundledFixtureDirectory = join(bundledSharedSchemaDirectory, "fixtures");
  const externalFixtures = (await listFilesRecursively(externalFixtureDirectory))
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => relative(externalFixtureDirectory, filePath))
    .sort();
  const bundledFixtures = (await listFilesRecursively(bundledFixtureDirectory))
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => relative(bundledFixtureDirectory, filePath))
    .sort();
  assert.deepEqual(
    bundledFixtures,
    externalFixtures,
    "bundled CI fixture mirror must contain exactly the external shared fixtures",
  );
  for (const relativePath of externalFixtures) {
    const [externalBytes, bundledBytes] = await Promise.all([
      readFile(join(externalFixtureDirectory, relativePath)),
      readFile(join(bundledFixtureDirectory, relativePath)),
    ]);
    assert.ok(
      externalBytes.equals(bundledBytes),
      `bundled CI fixture mirror drift: ${relativePath}`,
    );
  }
}

async function verifyCalibrationSchemaCopy() {
  const sharedCalibrationSchemaPath = join(
    sharedSchemaDirectory,
    "sim-calibration-case-v1.schema.json",
  );
  const [sharedSchemaBytes, localSchemaBytes] = await Promise.all([
    readFile(sharedCalibrationSchemaPath),
    readFile(localCalibrationSchemaPath),
  ]);
  assert.ok(
    sharedSchemaBytes.equals(localSchemaBytes),
    "the shared and arena-ts calibration schemas must remain byte-identical",
  );
}

async function validateOptionalLiveSamples(validator) {
  if (process.env.ARENA_SCHEMA_SAMPLE_LIVE !== "1") {
    return 0;
  }
  if (process.env.CI) {
    throw new Error("ARENA_SCHEMA_SAMPLE_LIVE is read-only local validation and must not run in CI");
  }
  if (!coordinationSchemasAvailable) {
    throw new Error("ARENA_SCHEMA_SAMPLE_LIVE requires the external coordination data root");
  }

  const requestedSampleCount = Number.parseInt(process.env.ARENA_SCHEMA_LIVE_SAMPLE_COUNT ?? "10", 10);
  assert.ok(
    Number.isSafeInteger(requestedSampleCount) && requestedSampleCount > 0,
    "ARENA_SCHEMA_LIVE_SAMPLE_COUNT must be a positive integer",
  );

  const samplesPerTenant = Math.max(1, Math.ceil(requestedSampleCount / 2));
  const selectedSamplePaths = [];
  for (const tenantId of ["t1", "t2"]) {
    const calibrationDirectory = join(sharedDataRoot, "runtime", tenantId, "calibration");
    const calibrationPaths = (await listFilesRecursively(calibrationDirectory))
      .filter((filePath) => filePath.endsWith(".json") && dirname(filePath).endsWith("cases"));
    selectedSamplePaths.push(...calibrationPaths.slice(-samplesPerTenant));
  }

  const boundedSamplePaths = selectedSamplePaths.slice(0, requestedSampleCount);
  assert.ok(boundedSamplePaths.length > 0, "no live calibration cases were found to sample");
  for (const samplePath of boundedSamplePaths) {
    const sample = await readJson(samplePath);
    validateInstance(validator, calibrationSchemaId, sample, samplePath);
  }
  return boundedSamplePaths.length;
}

await verifyBundledSharedDataMirror();
const validator = createValidator();
const sharedSchemaCount = await registerSharedSchemas(validator);
const sharedFixtureCount = await validateSharedFixtures(validator);
const typeScriptFixtureCount = await validateTypeScriptCalibrationFixtures(validator);
await verifyCalibrationSchemaCopy();
const liveSampleCount = await validateOptionalLiveSamples(validator);

console.log(
  `shared schema check passed: ${sharedSchemaCount} schemas, ${sharedFixtureCount} shared fixtures, `
    + `${typeScriptFixtureCount} TypeScript calibration fixtures, ${liveSampleCount} live samples`,
);
