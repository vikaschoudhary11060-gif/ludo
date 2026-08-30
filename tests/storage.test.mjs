/* ============================================================
   Persistent Storage Tests — MongoDB Atlas Persistence
   ============================================================ */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://vikaschoudhary11060_db_user:MbejATQnH8OiK4CY@cluster0.ouvpidm.mongodb.net/khelbro?retryWrites=true&w=majority';
import { connect, col } from '../server/src/lib/db.js';
import { saveFile, getFile, UPLOAD_ROOT } from '../server/src/lib/storage.js';

test('Persistent Image Storage Test Suite', async t => {
  await connect();

  const testBuffer = Buffer.from('test-image-content-bytes-123456');
  const fakeFile = {
    originalname: 'screenshot.png',
    mimetype: 'image/png',
    size: testBuffer.length,
    buffer: testBuffer,
  };

  let savedUrl = '';
  let filename = '';

  await t.test('1. saveFile persists to MongoDB and local disk', async () => {
    savedUrl = await saveFile(fakeFile, 'test-proof', 9999);
    assert.ok(savedUrl.startsWith('/uploads/test-proof-'), 'Returns public upload URL');

    filename = path.basename(savedUrl);

    // Verify in MongoDB
    const doc = await col('uploads').findOne({ filename });
    assert.ok(doc, 'Document exists in MongoDB uploads collection');
    assert.equal(doc.mimetype, 'image/png');
    assert.equal(doc.size, testBuffer.length);

    // Verify on local disk
    const diskPath = path.join(UPLOAD_ROOT, filename);
    assert.ok(fs.existsSync(diskPath), 'File was written to disk cache');
  });

  await t.test('2. getFile retrieves from disk cache', async () => {
    const file = await getFile(filename);
    assert.ok(file, 'getFile returned file');
    assert.equal(file.mimetype, 'image/png');
    assert.equal(file.buffer.toString(), 'test-image-content-bytes-123456');
  });

  await t.test('3. getFile retrieves from MongoDB when disk file is deleted (simulating Render redeploy)', async () => {
    const diskPath = path.join(UPLOAD_ROOT, filename);
    if (fs.existsSync(diskPath)) {
      fs.unlinkSync(diskPath);
    }
    assert.equal(fs.existsSync(diskPath), false, 'Disk file was deleted to simulate server redeploy');

    // Retrieve file
    const file = await getFile(filename);
    assert.ok(file, 'getFile retrieved file from MongoDB Atlas');
    assert.equal(file.mimetype, 'image/png');
    assert.equal(file.buffer.toString(), 'test-image-content-bytes-123456');

    // Verify disk cache was re-populated
    assert.ok(fs.existsSync(diskPath), 'Disk cache was re-created from MongoDB');
  });

  // Cleanup test record
  await col('uploads').deleteOne({ filename });
  const diskPath = path.join(UPLOAD_ROOT, filename);
  if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
});
