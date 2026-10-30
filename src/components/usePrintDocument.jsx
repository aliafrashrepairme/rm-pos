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
