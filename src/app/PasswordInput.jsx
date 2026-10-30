import { useState } from 'react';

export default function PasswordInput({ label, value, onChange, autoComplete, minLength }) {
  const [visible, setVisible] = useState(false);
  return (
    <label>{label}
      <span className="password-row">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required
        />
        <button type="button" className="password-toggle" aria-pressed={visible} onClick={() => setVisible(!visible)}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </span>
    </label>
  );
}
