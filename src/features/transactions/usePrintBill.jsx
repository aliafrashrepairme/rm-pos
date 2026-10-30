import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import Receipt from './Receipt.jsx';

// Renders the bill into the print area, then prints it or saves it as a PDF.
// Printing from the page keeps Tamil and Sinhala names intact, unlike drawing a PDF by hand.
export function usePrintBill() {
  const { t } = useI18n();
  const toast = useToast();
  const [job, setJob] = useState(null);

  useEffect(() => {
    if (!job) return undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.body.classList.remove('print-labels');
      setJob(null);
    };
    document.body.classList.add('print-labels');
    window.addEventListener('afterprint', finish);

    const record = () => api(`/api/transactions/bills/${job.bill.id}/printed`, { method: 'POST', body: JSON.stringify({ kind: job.kind }) })
      .catch((failure) => console.error('Could not record the printed bill:', failure.message));

    if (job.kind === 'pdf' && window.rmpos?.saveBillPdf) {
      window.rmpos.saveBillPdf(`${job.bill.billNo}.pdf`)
        .then((saved) => {
          if (saved) {
            record();
            toast(`${job.bill.billNo}.pdf ${t('saved.')}`);
          }
        })
        .catch(() => toast(t('The PDF could not be saved.')))
        .finally(finish);
    } else {
      // In a browser, the print dialog's "Save as PDF" does the same job.
      record();
      window.print();
    }

    return () => {
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('print-labels');
    };
  }, [job, t, toast]);

  const area = job && createPortal(<div id="printArea" className="print-receipt"><Receipt bill={job.bill} /></div>, document.body);
  return {
    printArea: area,
    printBill: (bill) => setJob({ bill, kind: 'print' }),
    saveBillPdf: (bill) => setJob({ bill, kind: 'pdf' })
  };
}
