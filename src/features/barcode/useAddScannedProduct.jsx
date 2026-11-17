import { useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import ProductForm from '../products/ProductForm.jsx';

// Lets a Manager or Inventory Staff add a product straight from an unknown scanned barcode.
// Other roles (such as Cashier) get canAdd = false and are asked to call a manager instead.
export function useAddScannedProduct(user, onAdded) {
  const { t } = useI18n();
  const toast = useToast();
  const canAdd = can(user, 'products.manage');
  const [options, setOptions] = useState(null);
  const [code, setCode] = useState(null);

  async function start(scannedCode) {
    try {
      if (!options) setOptions(await api('/api/products/options'));
      setCode(scannedCode);
    } catch (failure) {
      toast(t(failure.message));
    }
  }

  const form = code && options
    ? (
      <ProductForm
        options={options}
        barcode={code}
        onClose={() => setCode(null)}
        onSaved={() => {
          setCode(null);
          onAdded(code);
        }}
      />
    )
    : null;

  return { canAdd, start, form };
}
