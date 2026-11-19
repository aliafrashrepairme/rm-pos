import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { useToast } from './Toast.jsx';

// Renders a document into the print area, then prints it or saves it as a PDF.
// Printing from the page keeps Tamil and Sinhala names intact, unlike drawing a PDF by hand.
export function usePrintDocument() {
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

    if (job.kind === 'pdf' && window.rmpos?.savePdf) {
      window.rmpos.savePdf(job.fileName, job.size)
        .then((saved) => {
          if (saved) {
            job.onDone?.('pdf');
            toast(`${job.fileName} ${t('saved.')}`);
          }
        })
        .catch(() => toast(t('The PDF could not be saved.')))
        .finally(finish);
    } else if (job.kind !== 'pdf' && window.rmpos?.print) {
      // Receipts go to the receipt printer chosen in Printers; A4 and A5 documents to the document printer.
      const role = job.printer ?? (String(job.size).startsWith('receipt') ? 'receipt' : 'document');
      window.rmpos.print(job.size, role)
        .then(({ printed, cancelled, printerMissing }) => {
          if (printerMissing) toast(t('The printer chosen in Printers is not connected, so Windows chose one instead.'));
          if (printed) job.onDone?.(job.kind);
          else if (!cancelled) toast(t('It could not be printed. Check the printer and try again.'));
        })
        .catch(() => toast(t('It could not be printed. Check the printer and try again.')))
        .finally(finish);
    } else {
      // In a browser, the print dialog's "Save as PDF" does the same job.
      job.onDone?.(job.kind);
      window.print();
    }

    return () => {
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('print-labels');
    };
  }, [job, t, toast]);

  const printArea = job && createPortal(<div id="printArea" className={job.className}>{job.content}</div>, document.body);
  return { printArea, startPrint: setJob };
}
