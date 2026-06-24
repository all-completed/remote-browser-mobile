// QR scanning via the MLKit Google code scanner. The code scanner runs inside Google
// Play services and provides its own full-screen camera UI, so the app needs no camera
// permission. Returns the raw scanned text, or null if cancelled.
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';

export function canScan(): boolean {
  return Capacitor.isNativePlatform();
}

export async function scanQr(): Promise<string | null> {
  // Make sure the (downloadable) Google scanner module is present before scanning.
  try {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
  } catch {
    /* best effort — scan() will surface a clear error if it truly can't run */
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
  return barcodes && barcodes.length ? barcodes[0].rawValue : null;
}
