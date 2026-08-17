import React, { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { Card, Field, useToast } from '../lib/ui.jsx';

const BLANK = {
  name: '', phone: '', aadhar_no: '', address: '', dob_aadhar: '',
  dl_no: '', dl_dob: '', dl_valid_from: '', dl_valid_till: '',
  bank_account_name: '', bank_account_no: '', bank_ifsc: '', bank_name: '', uan_no: '',
  remarks: '',
};

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

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
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
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('payload', JSON.stringify({
        ...form,
        references: refs.filter((r) => r.name && r.phone),
        dob_mismatch_ack: dobAck || undefined,
      }));
      ['photo', 'aadhar_doc', 'dl_doc'].forEach((k) => files[k] && fd.append(k, files[k]));

      const res = await api.upload('/drivers', fd);
      toast.success(`Registered ${res.driver.name} — ${res.registration_no}`);
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

  const flag = (k) => (prefilled.includes(k) ? { background: '#fffbe9' } : undefined);

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

      <form onSubmit={submit}>
        <div className="grid c2">
          <Card title="Personal details">
            <Field label="Full name" hint="as on Aadhar">
              <input value={form.name} onChange={set('name')} style={flag('name')} required />
            </Field>
            <div className="grid c2">
              <Field label="Phone number">
                <input value={form.phone} onChange={set('phone')} style={flag('phone')}
                  placeholder="10 digit mobile" required />
              </Field>
              <Field label="Aadhar number">
                <input value={form.aadhar_no} onChange={set('aadhar_no')} style={flag('aadhar_no')}
                  placeholder="12 digits" required />
              </Field>
            </div>
            <Field label="Date of birth" hint="as per Aadhar">
              <input type="date" value={form.dob_aadhar} onChange={set('dob_aadhar')} style={flag('dob_aadhar')} />
            </Field>
            <Field label="Address">
              <textarea value={form.address} onChange={set('address')} style={flag('address')} />
            </Field>
            <Field label="UAN number" hint="optional">
              <input value={form.uan_no} onChange={set('uan_no')} style={flag('uan_no')} />
            </Field>
          </Card>

          <Card title="Driving licence">
            <Field label="Licence number">
              <input value={form.dl_no} onChange={set('dl_no')} style={flag('dl_no')} />
            </Field>
            <Field label="Date of birth on licence" hint="must match the Aadhar date of birth">
              <input type="date" value={form.dl_dob} onChange={set('dl_dob')} style={flag('dl_dob')} />
            </Field>
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
              <Field label="Valid till">
                <input type="date" value={form.dl_valid_till} onChange={set('dl_valid_till')} style={flag('dl_valid_till')} />
              </Field>
            </div>

            <h4 style={{ marginTop: 16, marginBottom: 10, fontSize: 13 }}>Documents</h4>
            <div className="grid c3">
              <FileInput label="Photograph" accept="image/*"
                onChange={(f) => setFiles((c) => ({ ...c, photo: f }))} />
              <FileInput label="Aadhar copy" accept="image/*,application/pdf"
                onChange={(f) => setFiles((c) => ({ ...c, aadhar_doc: f }))} />
              <FileInput label="Licence copy" accept="image/*,application/pdf"
                onChange={(f) => setFiles((c) => ({ ...c, dl_doc: f }))} />
            </div>
          </Card>

          <Card title="Bank account">
            <Field label="Account holder name" hint="leave blank to use the driver's name">
              <input value={form.bank_account_name} onChange={set('bank_account_name')} />
            </Field>
            <div className="grid c2">
              <Field label="Account number">
                <input value={form.bank_account_no} onChange={set('bank_account_no')} style={flag('bank_account_no')} />
              </Field>
              <Field label="IFSC code">
                <input value={form.bank_ifsc} onChange={set('bank_ifsc')} style={flag('bank_ifsc')} />
              </Field>
            </div>
            <Field label="Bank name">
              <input value={form.bank_name} onChange={set('bank_name')} style={flag('bank_name')} />
            </Field>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Bank details are needed before advances or salary can be paid through the bank sheet.
            </p>
          </Card>

          <Card title="Reference contacts" >
            <p className="small muted" style={{ marginTop: 0 }}>
              Two contact numbers of relatives — for example father and brother.
            </p>
            {refs.map((r, i) => (
              <div className="grid c3" key={i}>
                <Field label={`Reference ${i + 1} name`}>
                  <input value={r.name} onChange={(e) => setRefs((c) =>
                    c.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </Field>
                <Field label="Relation">
                  <select value={r.relation} onChange={(e) => setRefs((c) =>
                    c.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))}>
                    {['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Uncle', 'Other']
                      .map((o) => <option key={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Phone">
                  <input value={r.phone} onChange={(e) => setRefs((c) =>
                    c.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                </Field>
              </div>
            ))}
            <Field label="Remarks" hint="optional">
              <textarea value={form.remarks} onChange={set('remarks')} style={{ minHeight: 50 }} />
            </Field>
          </Card>
        </div>

        <div className="banner info">
          <span>ℹ</span>
          <div>
            On save the driver is allotted a registration number and enters the screening pipeline —
            trial test, safety orientation and medical. Only after all three are passed can the client
            issue a six digit ID and the driver be deployed.
          </div>
        </div>

        <div className="row">
          <button className="primary" disabled={busy || (dobMismatch && !dobAck)}>
            {busy ? <span className="spinner" /> : 'Register driver'}
          </button>
          <Link className="btn" to="/drivers">Cancel</Link>
        </div>
      </form>
    </Page>
  );
}

function FileInput({ label, accept, onChange }) {
  const ref = useRef();
  const [name, setName] = useState('');
  return (
    <Field label={label}>
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files[0]; setName(f?.name || ''); onChange(f); }} />
      <button type="button" style={{ width: '100%' }} onClick={() => ref.current.click()}>
        {name ? `📎 ${name.slice(0, 22)}` : 'Choose file…'}
      </button>
    </Field>
  );
}

/** Scan the client registration page and pre-fill the form. */
function ScanPanel({ onApply, onClose }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (text.trim()) fd.append('text', text);
      const res = await api.upload('/drivers/scan', fd);
      setResult(res);
      if (!res.matched) toast.info(res.message || 'Nothing could be read from that page.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Scan the client registration page"
      actions={<button onClick={onClose}>Close</button>}
    >
      <div className="grid c2">
        <div>
          <Field label="Upload the scanned page" hint="image or PDF">
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files[0])} />
          </Field>
          <Field label="Or paste the text from the page"
            hint="labelled lines such as “Name: …”, “Aadhaar No: …”">
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 150 }}
              placeholder={'Name: Rajesh Kumar\nMobile No: 9876543210\nAadhaar No: 1234 5678 9012\nDOB: 12/05/1988\nDriving Licence: DL0120100012345\nValid Upto: 30/11/2029\nAddress: H.No 21, Sector 45, Gurugram\nA/c No: 50100123456789\nIFSC: HDFC0001234\nFather: Ram Kumar - 9876500011'} />
          </Field>
          <button className="primary" onClick={run} disabled={busy || (!file && !text.trim())}>
            {busy ? <span className="spinner" /> : 'Read page'}
          </button>
        </div>

        <div>
          {!result && (
            <div className="banner info">
              <span>ℹ</span>
              <div>
                An uploaded page is stored against the registration. Text is read through the configured
                OCR service when <span className="mono">OCR_API_URL</span> is set; otherwise paste the
                text and the labelled fields are extracted here.
              </div>
            </div>
          )}
          {result && (
            <>
              <div className={`banner ${result.matched ? 'success' : 'warn'}`}>
                <span>{result.matched ? '✓' : '!'}</span>
                <div>{result.matched
                  ? `${result.matched} field(s) recognised.`
                  : (result.message || 'No labelled fields were recognised.')}</div>
              </div>
              {result.matched > 0 && (
                <>
                  <table className="tbl">
                    <thead><tr><th>Field</th><th>Value</th><th>Match</th></tr></thead>
                    <tbody>
                      {Object.entries(result.fields).filter(([k]) => k !== 'references').map(([k, v]) => (
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
                          <td><span className="chip grey">parsed</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button className="primary" style={{ marginTop: 12 }}
                    onClick={() => onApply(result.fields)}>
                    Pre-fill the form with these values
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
