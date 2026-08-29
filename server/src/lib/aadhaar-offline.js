/* ============================================================
   Offline Aadhaar eKYC (paperless KYC) verification.

   This is the FREE and licence-free route. The user downloads
   their own ZIP from myaadhaar.uidai.gov.in (or shares it via
   DigiLocker) and gives us the 4-character share code. We never
   call a UIDAI API, so no AUA/KUA licence is involved.

   What we do:
     1. open the ZIP with the share code
     2. parse the XML inside
     3. verify UIDAI's XML digital signature on it
     4. return only the fields we need

   The signature check requires UIDAI's public certificate. Point
   UIDAI_CERT_PATH at the .cer file downloaded from UIDAI. Without
   it we still parse, but the result is marked unverified and must
   not be auto-approved.

   NOTE: rules around Aadhaar use change. Confirm with a lawyer that
   this method is acceptable for your use case before relying on it.
   ============================================================ */
import fs from 'node:fs';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

const CERT_PATH = process.env.UIDAI_CERT_PATH || '';

export const certAvailable = () => !!(CERT_PATH && fs.existsSync(CERT_PATH));

/** UIDAI publishes the share code as 4 characters; the ZIP uses it as the password. */
function openZip(buffer, shareCode) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!entry) throw new Error('NO_XML');
  let xml;
  try {
    xml = zip.readAsText(entry, 'utf8', shareCode);
  } catch {
    throw new Error('BAD_SHARE_CODE');
  }
  if (!xml || !xml.trim().startsWith('<')) throw new Error('BAD_SHARE_CODE');
  return xml;
}

/** Verify UIDAI's XML-DSig against their published certificate. */
function verifySignature(xml) {
  if (!certAvailable()) return { verified: false, reason: 'NO_CERT' };
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const sigEl = doc.getElementsByTagName('Signature')[0];
    if (!sigEl) return { verified: false, reason: 'NO_SIGNATURE' };

    const pem = fs.readFileSync(CERT_PATH, 'utf8');
    const sig = new SignedXml({ publicCert: pem });
    sig.loadSignature(sigEl.toString());
    const ok = sig.checkSignature(xml);
    return ok ? { verified: true } : { verified: false, reason: 'SIGNATURE_MISMATCH' };
  } catch (e) {
    return { verified: false, reason: 'VERIFY_ERROR:' + e.message };
  }
}

/**
 * @param {Buffer} buffer  the offline eKYC ZIP
 * @param {string} shareCode  the 4-character code the user chose on the UIDAI site
 */
export function parseOfflineEkyc(buffer, shareCode) {
  const xml = openZip(buffer, shareCode);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  const first = tag => doc.getElementsByTagName(tag)[0] || null;
  const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);

  const root = first('OfflinePaperlessKyc') || doc.documentElement;
  const uid = first('UidData');
  const poi = first('Poi');
  const poa = first('Poa');
  const pht = first('Pht');

  if (!poi) throw new Error('NOT_OFFLINE_EKYC');

  // referenceId is <last 4 digits of Aadhaar><timestamp>
  const referenceId = attr(root, 'referenceId') || '';
  const last4 = referenceId.slice(0, 4);

  const signature = verifySignature(xml);

  return {
    verified: signature.verified,
    verifyReason: signature.reason || null,
    referenceId,
    maskedAadhaar: last4 ? `XXXX XXXX ${last4}` : null,
    name: attr(poi, 'name'),
    dob: attr(poi, 'dob'),
    gender: attr(poi, 'gender'),
    email: attr(poi, 'e') || null,     // SHA-256 hash, not the address itself
    mobile: attr(poi, 'm') || null,    // SHA-256 hash
    address: poa ? {
      careOf: attr(poa, 'careof'), house: attr(poa, 'house'), street: attr(poa, 'street'),
      landmark: attr(poa, 'landmark'), locality: attr(poa, 'loc'), vtc: attr(poa, 'vtc'),
      subdist: attr(poa, 'subdist'), district: attr(poa, 'dist'), state: attr(poa, 'state'),
      country: attr(poa, 'country'), pincode: attr(poa, 'pc'), postOffice: attr(poa, 'po'),
    } : null,
    photo: pht && pht.textContent ? pht.textContent.trim() : null,   // base64 JPEG
  };
}

/**
 * UIDAI hashes the mobile as SHA-256( mobile + shareCode ) repeated `lastDigit`
 * times, where lastDigit is the last digit of the Aadhaar number. With only the
 * masked number we cannot know that digit, so we try all ten.
 * Lets us confirm the eKYC belongs to the phone that signed up.
 */
export function mobileMatches(hashFromXml, mobile, shareCode) {
  if (!hashFromXml || !mobile) return false;
  for (let n = 1; n <= 10; n++) {
    let value = String(mobile) + String(shareCode);
    let digest = value;
    for (let i = 0; i < n; i++) {
      digest = crypto.createHash('sha256').update(digest).digest('hex');
    }
    if (digest.toLowerCase() === String(hashFromXml).toLowerCase()) return true;
  }
  return false;
}
