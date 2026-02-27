export default function Home() {
  return (
    <div style={{
      fontFamily: 'Arial, sans-serif',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      background: '#f7f7f2',
      color: '#333',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ color: '#1B365D', marginBottom: 8 }}>Silver Mirror</h1>
        <p style={{ color: '#666' }}>Cancellation Assistant API is running.</p>
        <p style={{ color: '#999', fontSize: 14 }}>
          Widget: <a href="/widget" style={{ color: '#1B365D' }}>/widget</a>
        </p>
      </div>
    </div>
  );
}
