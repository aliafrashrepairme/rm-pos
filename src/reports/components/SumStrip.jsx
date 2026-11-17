export default function SumStrip({ items }) {
  return (
    <div className="sum-strip">
      {items.map((item) => (
        <div key={item.label}>
          <span className="sl">{item.label}</span>
          <b className={item.down ? 'qty-down' : ''}>{item.value}</b>
          {item.note && <small>{item.note}</small>}
        </div>
      ))}
    </div>
  );
}
