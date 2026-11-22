import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const CAMERA_ERROR_MESSAGES = {
  NotAllowedError: 'تم رفض إذن الكاميرا. اسمح للمتصفح بالوصول إلى الكاميرا أو استخدم الإدخال اليدوي أدناه.',
  PermissionDeniedError: 'تم رفض إذن الكاميرا. اسمح للمتصفح بالوصول إلى الكاميرا أو استخدم الإدخال اليدوي أدناه.',
  NotFoundError: 'لم يُعثر على كاميرا متصلة بهذا الجهاز. يمكنك استخدام قارئ USB أو كتابة الرمز أدناه.',
  NotReadableError: 'الكاميرا مستخدمة من تطبيق آخر حاليًا.',
  OverconstrainedError: 'تعذر تشغيل الكاميرا بالإعدادات المطلوبة.',
};

export default function BarcodeScannerModal({ open, title = 'مسح الباركود بالكاميرا', onDetected, onClose }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const detectedOnceRef = useRef(false);

  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [cameraError, setCameraError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    detectedOnceRef.current = false;
    setCameraError(null);
    setManualCode('');

    let cancelled = false;

    async function startScanner() {
      if (!navigator?.mediaDevices?.getUserMedia) {
        setCameraError('المتصفح أو السياق الحالي لا يدعم تشغيل الكاميرا (تأكد من فتح التطبيق عبر HTTPS).');
        return;
      }
      setStarting(true);
      try {
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.DATA_MATRIX,
          BarcodeFormat.QR_CODE,
        ]);
        const reader = new BrowserMultiFormatReader(hints);

        const videoInputs = await BrowserMultiFormatReader.listVideoInputDevices().catch(() => []);
        if (!cancelled && videoInputs.length > 0) {
          setDevices(videoInputs);
        }

        const constraints = selectedDeviceId
          ? { video: { deviceId: { exact: selectedDeviceId } } }
          : { video: { facingMode: { ideal: 'environment' } } };

        const controls = await reader.decodeFromConstraints(constraints, videoRef.current, (result) => {
          if (cancelled || detectedOnceRef.current) return;
          if (result) {
            const text = result.getText?.();
            if (text && text.trim()) {
              detectedOnceRef.current = true;
              try {
                controlsRef.current?.stop();
              } catch {
                // ignore stop errors
              }
              onDetected(text.trim());
            }
          }
        });

        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        if (!cancelled) {
          const friendly = CAMERA_ERROR_MESSAGES[err?.name] ?? err?.message ?? 'تعذر تشغيل الكاميرا.';
          setCameraError(friendly);
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      try {
        controlsRef.current?.stop();
      } catch {
        // ignore stop errors
      }
      controlsRef.current = null;
    };
  }, [open, selectedDeviceId, onDetected]);

  if (!open) return null;

  function submitManual(event) {
    event.preventDefault();
    const cleaned = manualCode.trim();
    if (!cleaned) return;
    onDetected(cleaned);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-card scanner-modal">
        <div className="card-head">
          <h3 className="section-title">{title}</h3>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            ✕ إغلاق
          </button>
        </div>

        {devices.length > 1 && (
          <div className="field" style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="cam-select">اختيار الكاميرا</label>
            <select
              id="cam-select"
              className="select"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
            >
              <option value="">الكاميرا الخلفية التلقائية</option>
              {devices.map((cam, index) => (
                <option key={cam.deviceId || index} value={cam.deviceId}>
                  {cam.label || `كاميرا ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="scanner-viewport">
          <video ref={videoRef} className="scanner-video" muted playsInline autoPlay />
          <div className="scanner-reticle" aria-hidden="true">
            <span className="scanner-line" />
          </div>
          {starting && <span className="scanner-status">جارٍ تشغيل الكاميرا…</span>}
        </div>

        {cameraError && (
          <div className="alert alert-warn" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            {cameraError}
          </div>
        )}

        <form className="form" style={{ marginTop: '0.9rem' }} onSubmit={submitManual}>
          <div className="field">
            <label htmlFor="manual-scan-code">أو مرّر قارئ USB / أدخل الرمز يدويًا</label>
            <div className="input-with-action">
              <input
                id="manual-scan-code"
                className="input"
                dir="ltr"
                placeholder="مثال: 6291000012345 أو (01)06291000012345(17)270831(10)LOT1"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
              />
              <button className="btn btn-primary" type="submit" disabled={!manualCode.trim()}>
                تطبيق
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
