export function verifyEmailTemplate(data: { token: string; name: string }): { subject: string; html: string } {
  const url = "http://localhost:3000/auth/verify-email?token=" + encodeURIComponent(data.token);
  return {
    subject: "Ayo-SNBT — Verifikasi Email Kamu",
    html: `<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:auto">
      <h2>Halo ${data.name}!</h2>
      <p>Terima kasih sudah mendaftar di Ayo-SNBT. Klik tombol di bawah untuk memverifikasi email kamu:</p>
      <p><a href="${url}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Verifikasi Email</a></p>
      <p>Jika tombol tidak berfungsi, salin tautan ini: <br/><code>${url}</code></p>
      <p style="color:#888;font-size:12px">Tautan berlaku 24 jam. Abaikan email ini jika kamu tidak mendaftar.</p>
    </body></html>`
  };
}

export function resetPasswordTemplate(data: { token: string; name: string }): { subject: string; html: string } {
  const url = "http://localhost:3000/auth/reset-password?token=" + encodeURIComponent(data.token);
  return {
    subject: "Ayo-SNBT — Reset Kata Sandi",
    html: `<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:auto">
      <h2>Halo ${data.name}!</h2>
      <p>Kami menerima permintaan reset kata sandi akun Ayo-SNBT kamu. Klik tombol di bawah untuk membuat kata sandi baru:</p>
      <p><a href="${url}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Reset Kata Sandi</a></p>
      <p style="color:#888;font-size:12px">Tautan berlaku 15 menit. Jika kamu tidak meminta reset, abaikan email ini.</p>
    </body></html>`
  };
}


export function paymentReceiptTemplate(data: { name: string; orderNumber: string; amount: string; courseTitle: string }): { subject: string; html: string } {
  return {
    subject: "Ayo-SNBT — Pembayaran Berhasil: " + data.courseTitle,
    html: `<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:auto">
      <h2>Halo ${data.name}!</h2>
      <p>Pembayaran kamu berhasil. Berikut detailnya:</p>
      <p><strong>Kursus:</strong> ${data.courseTitle}<br/>
      <strong>Nomor Pesanan:</strong> ${data.orderNumber}<br/>
      <strong>Total:</strong> Rp ${data.amount}</p>
      <p>Kamu sekarang bisa langsung mulai belajar. Semangat persiapan SNBT! 🎓</p>
    </body></html>`
  };
}

export function renderTemplate(template: string, data: Record<string, unknown>): { subject: string; html: string } {
  switch (template) {
    case "verify-email":
      return verifyEmailTemplate(data as { token: string; name: string });
    case "reset-password":
      return resetPasswordTemplate(data as { token: string; name: string });
    case "payment-receipt":
      return paymentReceiptTemplate(data as { name: string; orderNumber: string; amount: string; courseTitle: string });
    default:
      throw new Error("Unknown email template: " + template);
  }
}