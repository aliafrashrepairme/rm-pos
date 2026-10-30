import { api } from '../../api.js';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import Receipt from './Receipt.jsx';

export function usePrintBill() {
  const { printArea, startPrint } = usePrintDocument();

  function start(bill, kind) {
    startPrint({
      kind,
      className: 'print-receipt',
      content: <Receipt bill={bill} />,
      fileName: `${bill.billNo}.pdf`,
      size: 'receipt',
      onDone: (done) => {
        api(`/api/transactions/bills/${bill.id}/printed`, { method: 'POST', body: JSON.stringify({ kind: done }) })
          .catch((failure) => console.error('Could not record the printed bill:', failure.message));
      }
    });
  }

  return {
    printArea,
    printBill: (bill) => start(bill, 'print'),
    saveBillPdf: (bill) => start(bill, 'pdf')
  };
}
