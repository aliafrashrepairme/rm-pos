const WARN = ['Low Stock', 'Part Paid', 'Unpaid', 'Pending', 'Partially Received', 'Partially Refunded', 'In Progress', 'Submitted', 'Sent'];
const RED = ['Refunded', 'Voided', 'Out of Stock', 'Rejected', 'Disabled', 'Expired', 'Overdue'];
const GRAY = ['Closed', 'Inactive', 'Draft', 'Ordered', 'Cancelled'];

export default function Status({ value, label }) {
  const tone = WARN.includes(value) ? 'warn' : RED.includes(value) ? 'red' : GRAY.includes(value) ? 'gray' : '';
  return <span className={`status ${tone}`}><span className="dot" />{label ?? value}</span>;
}
