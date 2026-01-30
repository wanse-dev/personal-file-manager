import multer from 'multer';
// se usa memoria para que Railway no guarde archivos fisicamente en su disco efímero
const storage = multer.memoryStorage();
export const upload = multer({ storage });
