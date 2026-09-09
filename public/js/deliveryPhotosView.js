// Shared renderer for an order's delivery photos (migration 0039): a strip
// of signed-URL thumbnails, plus an "Add photo" file input when canUpload.
import { getPhotosForOrder, uploadDeliveryPhoto, signedUrlFor } from './deliveryPhotos.js';
import { escapeHtml } from './data.js';

export async function renderDeliveryPhotos(container, orderId, { canUpload = false } = {}) {
  if (!container) return;
  const photos = getPhotosForOrder(orderId);
  container.innerHTML = `
    <div class="photo-strip">
      ${photos.length === 0
        ? '<p class="empty-hint">No delivery photos.</p>'
        : photos.map((p, i) => `<a class="photo-thumb" data-path="${escapeHtml(p.storagePath)}" target="_blank" rel="noopener noreferrer"><img alt="Delivery photo ${i + 1} of ${photos.length}" loading="lazy" /></a>`).join('')}
    </div>
    ${canUpload ? `
      <label class="btn btn-secondary photo-upload-btn">
        Add a photo
        <input type="file" accept="image/*" class="photo-upload-input" hidden />
      </label>
      <p class="form-status photo-upload-status" aria-live="polite"></p>` : ''}
  `;

  for (const a of container.querySelectorAll('.photo-thumb')) {
    const url = await signedUrlFor(a.dataset.path);
    if (url) { a.href = url; const img = a.querySelector('img'); if (img) img.src = url; }
  }

  if (canUpload) {
    const input = container.querySelector('.photo-upload-input');
    const status = container.querySelector('.photo-upload-status');
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      for (const file of files) {
        status.textContent = `Uploading ${file.name}…`;
        status.className = 'form-status';
        const r = await uploadDeliveryPhoto(orderId, file);
        if (!r.ok) { status.textContent = r.error; status.className = 'form-status error'; break; }
        status.textContent = '';
      }
      renderDeliveryPhotos(container, orderId, { canUpload });
    });
  }
}
