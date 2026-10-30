import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { money, quantity } from '../../app/format.js';
import Modal from '../../components/Modal.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { usePrintBill } from '../transactions/usePrintBill.jsx';

export default function SaleCompleteModal({ sale, onClose }) {
  const { t } = useI18n();
  const { payment } = sale;
  const { printArea, printBill, saveBillPdf } = usePrintBill();
  const [bill, setBill] = useState(null);

  useEffect(() => {
    api(`/api/transactions/bills/${sale.id}`)
      .then((result) => setBill(result.bill))
      .catch((failure) => console.error('Could not load the receipt:', failure.message));
  }, [sale.id]);

  return (
    <Modal title={`${t('Sale complete')} · ${sale.billNo}`} description={sale.customer} onClose={onClose}>
      {payment?.tendered !== null && payment?.tendered !== undefined && (
        <div className="balance ok sale-change"><span>{t('Balance to give customer')}</span><b>{money(payment.change)}</b></div>
      )}
      <div className="modal-scroll">
        {sale.lines.map((line) => (
          <div className="total-row" key={line.sku}>
            <span>{line.name} × {quantity(line.qty)}</span>
            <b>{money(line.total)}</b>
          </div>
        ))}
      </div>
      <div className="cart-totals">
        <div className="total-row"><span>{t('Subtotal')}</span><b>{money(sale.subtotal)}</b></div>
        {sale.discount > 0 && <div className="total-row disc"><span>{t(sale.discountLabel)}</span><b>− {money(sale.discount)}</b></div>}
        <div className="total-row"><span>{t('VAT')}</span><b>{money(sale.tax)}</b></div>
        <div className="total-row grand"><span>{t('TOTAL')}</span><span>{money(sale.total)}</span></div>
        {payment && <div className="total-row"><span>{t('Paid by')}</span><b>{t(payment.method)}</b></div>}
        {sale.pointsEarned > 0 && <div className="total-row"><span>{t('Loyalty points earned')}</span><b>+{sale.pointsEarned}</b></div>}
      </div>
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" disabled={!bill} onClick={() => saveBillPdf(bill)}>⇩ {t('Download PDF')}</button>
        <button type="button" className="btn btn-outline" disabled={!bill} onClick={() => printBill(bill)}>⎙ {t('Print bill')}</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>{t('New bill')}</button>
      </div>
      {printArea}
    </Modal>
  );
}
