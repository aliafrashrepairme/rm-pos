import { useEffect, useMemo, useRef, useState } from 'react';
import { createDuplicateFilter } from '../../app/barcode.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { startCamera } from '../barcode/cameraScan.js';

export default function CameraModal({ onCode, onClose }) {
  const { t } = useI18n();
  const video = useRef(null);
  const [error, setError] = useState('');
  const isNew = useMemo(() => createDuplicateFilter(), []);

  useEffect(() => {
    let stop;
    let cancelled = false;
    startCamera(video.current, (code) => {
      if (isNew(code)) onCode(code);
    })
      .then((stopCamera) => {
        if (cancelled) stopCamera();
        else stop = stopCamera;
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'No camera could be started. Use a scanner or type the code.');
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [isNew, onCode]);

  return (
    <Modal title={t('Camera scan')} description={t('Each barcode you show is added to the bill.')} onClose={onClose}>
      <div className="viewfinder">
        <video ref={video} playsInline muted aria-label={t('Camera preview')} />
        <div className="vf-frame" />
        <div className="vf-laser" />
      </div>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-primary" onClick={onClose}>{t('Close')}</button>
      </div>
    </Modal>
  );
}
