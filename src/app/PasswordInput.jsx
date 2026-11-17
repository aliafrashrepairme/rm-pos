import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';

export default function PasswordInput({ label, value, onChange, autoComplete, minLength }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">{label}
      <span className="password-row">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required
        />
        <button type="button" className="btn btn-outline btn-sm" aria-pressed={visible} onClick={() => setVisible(!visible)}>
          {visible ? t('Hide') : t('Show')}
        </button>
      </span>
    </label>
  );
}
