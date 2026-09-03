import React, { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { Card, Field, useAsync, useToast } from '../lib/ui.jsx';

const BLANK = {
  name: '', phone: '', aadhar_no: '', address: '', dob_aadhar: '',
  dl_no: '', dl_dob: '', dl_valid_from: '', dl_valid_till: '',
  bank_account_name: '', bank_account_no: '', bank_ifsc: '', bank_name: '', uan_no: '',
  referred_by: '', remarks: '',
};

/**
 * The registration form, field for field from the scope document:
 *
 *    1 Name*                       7 Driving License No, validity and DOB*
 *    2 Photo*                      8 Copy of Aadhar and DL upload*
 *    3 Phone number*               9 Reference contact numbers (two)*
 *    4 Aadhar Card Number*        10 Bank Account Details
 *    5 Address*                   11 UAN number
 *    6 Date of birth per Aadhar*  12 Name of person who referred the driver
 *
 * Starred fields are mandatory. 10 and 11 are not, because the scope allows
 * those two to be completed at the deployment step instead.
 */
const MANDATORY = [
  ['name', 'Name'],
  ['phone', 'Phone number'],
  ['aadhar_no', 'Aadhar Card Number'],
  ['address', 'Address'],
  ['dob_aadhar', 'Date of birth as per Aadhar'],
  ['dl_no', 'Driving License No'],
  ['dl_valid_till', 'Driving License validity'],
  ['dl_dob', 'Date of birth as per Driving License'],
];

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Format checks, run as you type.
 *
 * A field that is merely blank is reported as outstanding rather than wrong —
 * these only fire once something has been entered, so the form does not scold
 * you for not having filled it in yet. Each returns an error string or null.
 *
 * The same rules are enforced again on the server; these exist so the mistake
 * is caught at the keyboard rather than on submit.
 */
const VALIDATORS = {
  name: (v) => (v && v.trim().length < 2 ? 'Enter the driver’s full name' : null),

  // Indian mobile numbers are ten digits and start 6-9.
  phone: (v) => {
    if (!v) return null;
    const d = digits(v);
    if (d.length !== 10) return `Must be exactly 10 digits — ${d.length} entered`;
    if (!/^[6-9]/.test(d)) return 'An Indian mobile number starts with 6, 7, 8 or 9';
    return null;
  },

  // Aadhaar is twelve digits and never starts with 0 or 1.
  aadhar_no: (v) => {
    if (!v) return null;
    const d = digits(v);
    if (d.length !== 12) return `Must be exactly 12 digits — ${d.length} entered`;
    if (/^[01]/.test(d)) return 'An Aadhar number does not start with 0 or 1';
    if (/^(\d)\1{11}$/.test(d)) return 'That is the same digit twelve times — check the number';
    return null;
  },

  dob_aadhar: (v) => {
    if (!v) return null;
    const age = ageOn(v);
    if (age === null) return 'Enter a valid date';
    if (age < 18) return `That is a date of birth ${age} years ago — a driver must be 18 or over`;
    if (age > 75) return 'Check the year — that is over 75 years ago';
    return null;
  },
  dl_dob: (v) => VALIDATORS.dob_aadhar(v),

  dl_no: (v) => {
    if (!v) return null;
    const t = v.toUpperCase().replace(/[\s-]/g, '');
    if (t.length < 9) return 'A licence number is at least 9 characters, e.g. BR3120180004512';
    if (!/^[A-Z]{2}/.test(t)) return 'A licence number starts with the two letter state code, e.g. BR, DL, RJ';
    return null;
  },

  dl_valid_till: (v, form) => {
    if (!v) return null;
    if (form.dl_valid_from && v <= form.dl_valid_from) return 'Validity must end after it begins';
    if (v < new Date().toISOString().slice(0, 10)) return 'This licence has already expired';
    return null;
  },

  uan_no: (v) => {
    if (!v) return null;
    const d = digits(v);
    return d.length === 12 ? null : `A UAN is 12 digits — ${d.length} entered`;
  },

  bank_account_no: (v) => {
    if (!v) return null;
    const d = digits(v);
    return d.length >= 9 && d.length <= 18 ? null : 'An account number is between 9 and 18 digits';
  },

  bank_ifsc: (v) => {
    if (!v) return null;
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase())
      ? null
      : 'An IFSC code is 11 characters, e.g. SBIN0004521';
  },
};

/** Whole years between a date of birth and today; null if it is not a date. */
function ageOn(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const before = now.getUTCMonth() < d.getUTCMonth()
    || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (before) age -= 1;
  return age;
}

const refPhoneError = (v) => (v ? VALIDATORS.phone(v) : null);

export default function DriverRegister() {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState(BLANK);
  const [refs, setRefs] = useState([
    { name: '', relation: 'Father', phone: '' },
    { name: '', relation: 'Brother', phone: '' },
  ]);
  const [files, setFiles] = useState({});
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [prefilled, setPrefilled] = useState([]);
  const [dobAck, setDobAck] = useState(false);
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [touched, setTouched] = useState({});

  // What is still outstanding against the starred fields, live as you type.
  const missing = [
    ...MANDATORY.filter(([k]) => !String(form[k] || '').trim()).map(([, label]) => label),
    ...(files.photo ? [] : ['Photo']),
    ...(files.aadhar_doc ? [] : ['Copy of Aadhar']),
    ...(files.dl_doc ? [] : ['Copy of Driving License']),
    ...(refs.filter((r) => r.name && r.phone).length >= 2 ? [] : ['Two reference contacts']),
  ];

  // Anything filled in but wrong. This is separate from `missing`: an
  // incomplete registration may be saved deliberately, but a wrong number
  // never may — the whole point of the check is that it is caught here.
  const errors = {};
  Object.entries(VALIDATORS).forEach(([k, check]) => {
    const err = check(form[k], form);
    if (err) errors[k] = err;
  });
  refs.forEach((r, i) => {
    const err = refPhoneError(r.phone);
    if (err) errors[`ref${i}`] = err;
  });
  const errorCount = Object.keys(errors).length;

  // Show an error only once the field has been touched or a save attempted.
  const show = (k) => (touched[k] || touched.__submitted ? errors[k] : null);
  const markTouched = (k) => () => setTouched((t) => ({ ...t, [k]: true }));

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  /** For fields that may only ever contain digits, capped at their real width. */
  const setDigits = (k, max) => (e) =>
    setForm((f) => ({ ...f, [k]: digits(e.target.value).slice(0, max) }));

  const dobMismatch = form.dob_aadhar && form.dl_dob && form.dob_aadhar !== form.dl_dob;

  function applyScan(fields) {
    const applied = [];
    setForm((f) => {
      const next = { ...f };
      Object.entries(fields).forEach(([k, v]) => {
        if (k === 'references' || !(k in BLANK) || !v) return;
        next[k] = v;
        applied.push(k);
      });
      return next;
    });
    if (Array.isArray(fields.references) && fields.references.length) {
      setRefs((cur) => fields.references.concat(cur).slice(0, 2));
      applied.push('references');
    }
    setPrefilled(applied);
    setScanOpen(false);
    toast.success(applied.length
      ? `Pre-filled ${applied.length} field(s) from the scan — please verify before saving.`
      : 'No fields could be read from that page.');
  }

  async function submit(e) {
    e.preventDefault();
    setTouched((t) => ({ ...t, __submitted: true }));
    if (errorCount) {
      toast.error(`${errorCount} field(s) need correcting before this can be saved.`);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('payload', JSON.stringify({
        ...form,
        references: refs.filter((r) => r.name && r.phone),
        dob_mismatch_ack: dobAck || undefined,
        allow_incomplete: allowIncomplete || undefined,
      }));
      ['photo', 'aadhar_doc', 'dl_doc'].forEach((k) => files[k] && fd.append(k, files[k]));

      const res = await api.upload('/drivers', fd);
      const short = res.completeness?.missing?.length;
      toast.success(short
        ? `Registered ${res.driver.name} — ${res.registration_no} (${short} field(s) still outstanding)`
        : `Registered ${res.driver.name} — ${res.registration_no}`);
      navigate(`/drivers/${res.id}`);
    } catch (err) {
      toast.error(err);
      if (err.details?.code === 'DUPLICATE_AADHAR' && err.details.driverId) {
        navigate(`/drivers/${err.details.driverId}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const flag = (k) => (prefilled.includes(k) ? ' prefilled' : '');

  return (
    <Page
      title="Register driver"
      subtitle="A registration number is allotted automatically on save"
      actions={<>
        <button onClick={() => setScanOpen(true)}>📄 Scan registration page</button>
        <Link className="btn" to="/drivers">Cancel</Link>
      </>}
    >
      {scanOpen && <ScanPanel onApply={applyScan} onClose={() => setScanOpen(false)} />}
      {prefilled.length > 0 && (
        <div className="banner warn">
          <span>✎</span>
          <div>Highlighted fields were pre-filled from the scanned page. Check them against the
            original documents before saving.</div>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <div className="grid c2">
          {/* 1 Name, 2 Photo, 3 Phone, 4 Aadhar, 5 Address, 6 DOB */}
          <Card title="Personal details">
            <div className={`field-wrap${flag('name')}`}>
              <Field label="Full name" hint="as on Aadhar" required error={show('name')}>
                <input value={form.name} onChange={set('name')} onBlur={markTouched('name')}
                  maxLength={80} autoComplete="off" />
              </Field>
            </div>

            <Field label="Photograph" required
              error={touched.__submitted && !files.photo ? 'A photograph is required' : null}>
              <FileInput accept="image/*" file={files.photo}
                onChange={(f) => setFiles((c) => ({ ...c, photo: f }))} />
            </Field>

            <div className="grid c2">
              <div className={`field-wrap${flag('phone')}`}>
                <Field label="Phone number" hint="10 digits" required error={show('phone')}>
                  <input
                    value={form.phone} onChange={setDigits('phone', 10)} onBlur={markTouched('phone')}
                    inputMode="numeric" maxLength={10} placeholder="9876543210" autoComplete="off"
                  />
                </Field>
              </div>
              <div className={`field-wrap${flag('aadhar_no')}`}>
                <Field label="Aadhar number" hint="12 digits" required error={show('aadhar_no')}>
                  <input
                    value={form.aadhar_no} onChange={setDigits('aadhar_no', 12)}
                    onBlur={markTouched('aadhar_no')}
                    inputMode="numeric" maxLength={12} placeholder="123456789012" autoComplete="off"
                  />
                </Field>
              </div>
            </div>

            <div className={`field-wrap${flag('address')}`}>
              <Field label="Address" required error={show('address')}>
                <textarea value={form.address} onChange={set('address')} onBlur={markTouched('address')}
                  maxLength={300} />
              </Field>
            </div>

            <div className={`field-wrap${flag('dob_aadhar')}`}>
              <Field label="Date of birth" hint="as per Aadhar" required error={show('dob_aadhar')}>
                <input type="date" value={form.dob_aadhar} onChange={set('dob_aadhar')}
                  onBlur={markTouched('dob_aadhar')} max={new Date().toISOString().slice(0, 10)} />
              </Field>
            </div>
          </Card>

          {/* 7 Driving licence, 8 Document copies */}
          <Card title="Driving licence">
            <div className={`field-wrap${flag('dl_no')}`}>
              <Field label="Licence number" hint="e.g. BR3120180004512" required error={show('dl_no')}>
                <input
                  value={form.dl_no}
                  onChange={(e) => setForm((f) => ({ ...f, dl_no: e.target.value.toUpperCase() }))}
                  onBlur={markTouched('dl_no')} maxLength={20} autoComplete="off"
                />
              </Field>
            </div>

            <div className={`field-wrap${flag('dl_dob')}`}>
              <Field label="Date of birth on licence" hint="must match the Aadhar date of birth"
                required error={show('dl_dob')}>
                <input type="date" value={form.dl_dob} onChange={set('dl_dob')}
                  onBlur={markTouched('dl_dob')} max={new Date().toISOString().slice(0, 10)} />
              </Field>
            </div>

            {dobMismatch && (
              <div className="banner error">
                <span>⚠</span>
                <div>
                  Aadhar shows <b>{form.dob_aadhar}</b> but the licence shows <b>{form.dl_dob}</b>.
                  Correct the entry, or tick below to record the exception with the registration.
                  <label className="check" style={{ marginTop: 6 }}>
                    <input type="checkbox" checked={dobAck} onChange={(e) => setDobAck(e.target.checked)} />
                    Record this mismatch as a known exception
                  </label>
                </div>
              </div>
            )}

            <div className="grid c2">
              <Field label="Valid from">
                <input type="date" value={form.dl_valid_from} onChange={set('dl_valid_from')} />
              </Field>
              <div className={`field-wrap${flag('dl_valid_till')}`}>
                <Field label="Valid till" required error={show('dl_valid_till')}>
                  <input type="date" value={form.dl_valid_till} onChange={set('dl_valid_till')}
                    onBlur={markTouched('dl_valid_till')} />
                </Field>
              </div>
            </div>

            <h4 style={{ marginTop: 16, marginBottom: 10, fontSize: 13 }}>Document copies</h4>
            <div className="grid c2">
              <Field label="Aadhar copy" required
                error={touched.__submitted && !files.aadhar_doc ? 'A copy of the Aadhar is required' : null}>
                <FileInput accept="image/*,application/pdf" file={files.aadhar_doc}
                  onChange={(f) => setFiles((c) => ({ ...c, aadhar_doc: f }))} />
              </Field>
              <Field label="Licence copy" required
                error={touched.__submitted && !files.dl_doc ? 'A copy of the licence is required' : null}>
                <FileInput accept="image/*,application/pdf" file={files.dl_doc}
                  onChange={(f) => setFiles((c) => ({ ...c, dl_doc: f }))} />
              </Field>
            </div>
          </Card>

          {/* 10 Bank account, 11 UAN */}
          <Card title="Bank account & UAN">
            <p className="small muted" style={{ marginTop: 0 }}>
              Not mandatory here — these may instead be completed at the deployment step. They are
              needed before the driver can be paid an advance or a salary.
            </p>
            <Field label="Account holder name" hint="leave blank to use the driver's name">
              <input value={form.bank_account_name} onChange={set('bank_account_name')} maxLength={80} />
            </Field>
            <div className="grid c2">
              <div className={`field-wrap${flag('bank_account_no')}`}>
                <Field label="Account number" hint="9–18 digits" error={show('bank_account_no')}>
                  <input value={form.bank_account_no} onChange={setDigits('bank_account_no', 18)}
                    onBlur={markTouched('bank_account_no')} inputMode="numeric" maxLength={18} />
                </Field>
              </div>
              <div className={`field-wrap${flag('bank_ifsc')}`}>
                <Field label="IFSC code" hint="e.g. SBIN0004521" error={show('bank_ifsc')}>
                  <input
                    value={form.bank_ifsc}
                    onChange={(e) => setForm((f) => ({
                      ...f, bank_ifsc: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11),
                    }))}
                    onBlur={markTouched('bank_ifsc')} maxLength={11}
                  />
                </Field>
              </div>
            </div>
            <div className={`field-wrap${flag('bank_name')}`}>
              <Field label="Bank name">
                <input value={form.bank_name} onChange={set('bank_name')} maxLength={60} />
              </Field>
            </div>
            <div className={`field-wrap${flag('uan_no')}`}>
              <Field label="UAN number" hint="12 digits" error={show('uan_no')}>
                <input value={form.uan_no} onChange={setDigits('uan_no', 12)}
                  onBlur={markTouched('uan_no')} inputMode="numeric" maxLength={12} />
              </Field>
            </div>
          </Card>

          {/* 9 Reference contacts, 12 Referred by */}
          <Card title="Reference contacts">
            <p className="small muted" style={{ marginTop: 0 }}>
              Two contact numbers of relatives — for example father and brother.
            </p>
            {refs.map((r, i) => (
              <div className="grid c3" key={i}>
                <Field label={`Reference ${i + 1} name`} required>
                  <input value={r.name} maxLength={60} onChange={(e) => setRefs((c) =>
                    c.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </Field>
                <Field label="Relation">
                  <select value={r.relation} onChange={(e) => setRefs((c) =>
                    c.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))}>
                    {['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Uncle', 'Other']
                      .map((o) => <option key={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Phone" hint="10 digits" required error={show(`ref${i}`)}>
                  <input
                    value={r.phone} inputMode="numeric" maxLength={10}
                    onBlur={markTouched(`ref${i}`)}
                    onChange={(e) => setRefs((c) => c.map((x, j) => (
                      j === i ? { ...x, phone: digits(e.target.value).slice(0, 10) } : x)))}
                  />
                </Field>
              </div>
            ))}

            <div className={`field-wrap${flag('referred_by')}`}>
              <Field label="Referred by" hint="name of the person who referred the driver">
                <input value={form.referred_by} onChange={set('referred_by')} maxLength={60} />
              </Field>
            </div>
            <Field label="Remarks" hint="optional">
              <textarea value={form.remarks} onChange={set('remarks')} maxLength={300}
                style={{ minHeight: 50 }} />
            </Field>
          </Card>
        </div>

        {errorCount > 0 && (touched.__submitted || Object.keys(touched).length > 0) && (
          <div className="banner error">
            <span>⚠</span>
            <div>
              <b>{errorCount} field(s) need correcting:</b>{' '}
              {Object.values(errors).join(' · ')}
            </div>
          </div>
        )}

        {missing.length > 0 && (
          <div className="banner warn">
            <span>!</span>
            <div>
              <b>Still to complete:</b> {missing.join(', ')}.
              <div className="small" style={{ marginTop: 4 }}>
                These are the mandatory fields of the registration form. If one genuinely cannot be
                obtained today, tick below — the driver is saved as an incomplete registration and the
                gap stays visible on their profile.
              </div>
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={allowIncomplete}
                  onChange={(e) => setAllowIncomplete(e.target.checked)} />
                Save as an incomplete registration
              </label>
            </div>
          </div>
        )}

        <div className="banner info">
          <span>ℹ</span>
          <div>
            On save the driver is allotted a registration number and enters the screening pipeline —
            trial test, safety orientation and medical. Only after all three are passed can the client
            issue a six digit ID and the driver be deployed. Bank details and the UAN may instead be
            completed at the deployment step.
          </div>
        </div>

        <div className="row">
          <button className="primary"
            disabled={busy || errorCount > 0 || (dobMismatch && !dobAck)
              || (missing.length > 0 && !allowIncomplete)}>
            {busy ? <span className="spinner" /> : 'Register driver'}
          </button>
          <Link className="btn" to="/drivers">Cancel</Link>
        </div>
      </form>
    </Page>
  );
}

/**
 * A file chooser that reads as a button. It sits inside a Field rather than
 * providing its own, so a missing document is marked as required and errors
 * the same way every other mandatory field on the form does.
 */
function FileInput({ accept, file, onChange }) {
  const ref = useRef();
  return (
    <>
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }}
        onChange={(e) => onChange(e.target.files[0])} />
      <div className="row">
        <button type="button" style={{ flex: 1, justifyContent: 'flex-start' }}
          onClick={() => ref.current.click()}>
          {file ? `📎 ${file.name.length > 26 ? `${file.name.slice(0, 26)}…` : file.name}` : 'Choose file…'}
        </button>
        {file && (
          <button type="button" className="sm" title="Remove" onClick={() => {
            onChange(undefined);
            if (ref.current) ref.current.value = '';
          }}>✕</button>
        )}
      </div>
    </>
  );
}

/**
 * "Scan the client registration page to populate the fields of registration,
 * and fields which are blank should be populated manually by supervisor."
 *
 * Takes any mix of PDFs, photographs and pasted text — the client page, the
 * Aadhaar card and the licence can go up together and the fields are merged.
 * A client page is usually a list of drivers rather than one form, so when
 * rows are found the supervisor picks the driver off the list.
 */
function ScanPanel({ onApply, onClose }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState(null);
  const ocr = useAsync(() => api.get('/drivers/scan/status'), []);

  async function run() {
    setBusy(true);
    setResult(null);
    setPicked(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      if (text.trim()) fd.append('text', text);
      const res = await api.upload('/drivers/scan', fd);
      setResult(res);
      if (!res.matched && !res.rows?.length) {
        toast.info(res.message || 'Nothing could be read from that page.');
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  /** Apply the merged fields, plus the driver picked off a client page. */
  function apply() {
    const fields = { ...result.fields };
    if (picked) {
      fields.name = picked.name;
      if (picked.registered_no && !picked.registeredNoTruncated) {
        fields.registered_no = picked.registered_no;
      }
    }
    onApply(fields);
  }

  const engines = ocr.data;
  const rows = result?.rows || [];
  const entries = Object.entries(result?.fields || {}).filter(([k]) => k !== 'references');

  return (
    <Card
      title="Scan the client registration page"
      actions={<button onClick={onClose}>Close</button>}
    >
      <div className="grid c2">
        <div>
          <Field label="Upload the page" hint="PDF or photo — several files at once is fine">
            <input
              type="file" multiple accept="image/*,application/pdf"
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
          </Field>
          {files.length > 0 && (
            <div className="small muted" style={{ marginBottom: 8 }}>
              {files.map((f) => f.name).join(', ')}
            </div>
          )}

          <Field label="Or paste the text from the page"
            hint="labelled lines such as “Name: …”, “Aadhaar No: …”">
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 130 }}
              placeholder={'Name: Rajesh Kumar\nMobile No: 9876543210\nAadhaar No: 1234 5678 9012\nDOB: 12/05/1988\nDriving Licence: DL0120100012345\nValid Upto: 30/11/2029\nAddress: H.No 21, Sector 45, Gurugram\nA/c No: 50100123456789\nIFSC: HDFC0001234\nFather: Ram Kumar - 9876500011'} />
          </Field>

          <button className="primary" onClick={run} disabled={busy || (!files.length && !text.trim())}>
            {busy ? <><span className="spinner" /> Reading…</> : 'Read page'}
          </button>

          {engines && (
            <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
              {engines.remote
                ? 'Pages are read through the configured OCR service.'
                : engines.local
                  ? `Pages are read on this server (${engines.languages}). A scanned page takes a few seconds.`
                  : 'No OCR engine is available — paste the text from the page instead.'}
            </p>
          )}
        </div>

        <div>
          {!result && (
            <div className="banner info">
              <span>ℹ</span>
              <div>
                A PDF that already carries text is read straight off. A scan or a printed page is
                read by OCR. Everything read is a <b>suggestion</b> — check it against the original
                before saving, and type in anything that came back blank.
              </div>
            </div>
          )}

          {result && (
            <>
              <div className={`banner ${result.matched || rows.length ? 'success' : 'warn'}`}>
                <span>{result.matched || rows.length ? '✓' : '!'}</span>
                <div>
                  {result.matched > 0 && <>{result.matched} field(s) recognised. </>}
                  {rows.length > 0 && <>{rows.length} driver row(s) found on the page. </>}
                  {!result.matched && !rows.length && (result.message || 'Nothing was recognised.')}
                </div>
              </div>

              {result.documents?.length > 0 && (
                <p className="small muted">
                  {result.documents.map((d) => (
                    `${d.source} — ${d.engine}${d.confidence == null ? '' : `, ${Math.round(d.confidence)}% confidence`}`
                  )).join(' · ')}
                </p>
              )}

              {rows.length > 0 && (
                <>
                  <h4 style={{ margin: '10px 0 6px', fontSize: 13 }}>
                    Which driver is being registered?
                  </h4>
                  <div className="pick-list">
                    {rows.map((r, i) => (
                      <button
                        type="button" key={`${r.registered_no}-${i}`}
                        style={picked === r ? { background: '#e6f0fb' } : undefined}
                        onClick={() => setPicked(picked === r ? null : r)}
                      >
                        <span className="who">{r.name}</span>
                        {r.nameTruncated && <span className="chip amber">name cut off</span>}
                        <span className="mono small muted">{r.registered_no}</span>
                      </button>
                    ))}
                  </div>
                  <p className="small muted" style={{ marginTop: 6 }}>
                    The client portal truncates long values, so check the picked name against the
                    original page before saving.
                  </p>
                </>
              )}

              {entries.length > 0 && (
                <table className="tbl" style={{ marginTop: 10 }}>
                  <thead><tr><th>Field</th><th>Value</th><th>Match</th></tr></thead>
                  <tbody>
                    {entries.map(([k, v]) => (
                      <tr key={k}>
                        <td>{k.replace(/_/g, ' ')}</td>
                        <td className="mono">{String(v)}</td>
                        <td><span className="chip grey">{result.confidence?.[k] || 'parsed'}</span></td>
                      </tr>
                    ))}
                    {result.fields.references?.map((r, i) => (
                      <tr key={`r${i}`}>
                        <td>reference {i + 1}</td>
                        <td className="mono">{r.name} ({r.relation}) {r.phone}</td>
                        <td><span className="chip grey">labelled</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {(entries.length > 0 || picked) && (
                <button className="primary" style={{ marginTop: 12 }} onClick={apply}>
                  Pre-fill the form with these values
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
