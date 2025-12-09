import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";

// Establecer la ruta donde se guardarán las miniaturas temporales
const TEMP_THUMB_DIR = path.join(process.cwd(), "temp_thumbs");
if (!fs.existsSync(TEMP_THUMB_DIR)) fs.mkdirSync(TEMP_THUMB_DIR);

/**
 * Genera una miniatura para una imagen o un video.
 * @param {object} file - Objeto file de Multer (con path y mimetype).
 * @returns {Promise<string>} La ruta completa al archivo de miniatura generado.
 */
export async function generateThumbnail(file) {
  const fileExt = path.extname(file.originalname).toLowerCase();
  // Miniaturas de video siempre serán JPG. Imágenes mantendrán su formato.
  const thumbName = `thumb_${Date.now()}${fileExt === '.mp4' || fileExt === '.webm' || fileExt === '.ogg' ? '.jpg' : fileExt}`;
  const thumbPath = path.join(TEMP_THUMB_DIR, thumbName);
  const isVideo = ["mp4", "webm", "ogg"].includes(fileExt.replace('.', ''));

  try {
    if (isVideo) {
      // Procesamiento de Video (captura el primer frame)
      return new Promise((resolve, reject) => {
        // Asegura que ffmpeg esté accesible en el entorno de Render
        ffmpeg(file.path)
          .frames(1) 
          .size('150x150')
          .outputOptions(['-f image2', '-vframes 1', '-vf', 'scale=150:150:force_original_aspect_ratio=increase,crop=150:150']) // Forzar 150x150
          .on('end', () => resolve(thumbPath))
          .on('error', (err) => {
            console.error('FFmpeg Error:', err.message);
            reject(new Error('Error al generar miniatura de video: ' + err.message));
          })
          .save(thumbPath);
      });
    } else {
      // Procesamiento de Imagen (recorta y redimensiona)
      await sharp(file.path)
        .resize(150, 150, { fit: 'cover' }) // 'cover' recorta para ajustarse al tamaño
        .toFile(thumbPath);
      return thumbPath;
    }
  } catch (error) {
    console.error("Error al generar miniatura:", error);
    throw error;
  }
}

/**
 * Elimina una miniatura temporal.
 */
export function cleanupThumbnail(thumbPath) {
    if (fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
    }
}