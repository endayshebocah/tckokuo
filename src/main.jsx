import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// Baris ini adalah kunci untuk memuat semua style Tailwind CSS Anda
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

