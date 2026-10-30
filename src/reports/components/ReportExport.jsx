import { downloadCsv, printReport } from '../utils/reportExport.js';

export default function ReportExport({ filename, columns, rows }) {
  return (
    <div className="rpt-export">
      <button className="btn-outline" onClick={printReport} type="button">⎙ Print</button>
      <button className="btn-primary" onClick={() => downloadCsv(filename, columns, rows)} type="button">Export CSV</button>
    </div>
  );
}
