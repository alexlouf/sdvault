self.onmessage = async (e) => {
    const { url, id } = e.data;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erreur réseau: ${response.status}`);
        }
        const blob = await response.blob();
        
        // C'est ici que la magie opère : décodage natif hors du thread principal avec respect de l'orientation EXIF
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        
        // Transfert du bitmap vers le thread principal (Zero-Copy)
        self.postMessage({ id, bitmap, success: true }, [bitmap]);
    } catch (err) {
        self.postMessage({ id, error: err.message, success: false });
    }
};
