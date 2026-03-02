export default function Home() {
  return (
    <div style={{
      fontFamily: 'Arial, sans-serif',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      background: '#f8fafc',
      color: '#333',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ color: '#1a1a1a', marginBottom: 8 }}>Silver Mirror</h1>
        <p style={{ color: '#666' }}>Virtual Assistant API is running.</p>
        <p style={{ color: '#999', fontSize: 14, marginTop: 12 }}>
          Chat: <a href="/widget" style={{ color: '#50aaf2' }}>/widget</a>
          {' · '}
          Embed demo: <a href="/embed.html" style={{ color: '#50aaf2' }}>/embed.html</a>
        </p>
      </div>
    </div>
  );
}
