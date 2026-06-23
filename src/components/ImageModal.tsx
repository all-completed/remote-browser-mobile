// Full-screen image overlay (plain DOM — no IonModal, so presentation is
// deterministic). Tap anywhere to close.
interface Props {
  src: string | null;
  onClose: () => void;
}

export default function ImageModal({ src, onClose }: Props) {
  if (!src) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 30000,
        background: 'rgba(2, 6, 23, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
        padding: 16,
      }}
    >
      <img src={src} alt="Proof screenshot" style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
    </div>
  );
}
