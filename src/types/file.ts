export interface File {
  id_file?: number;
  original_name: string;
  extension: string;
  size: number;
  category: 'binary' | 'text';
  location: 'local' | 'cloud';
  url_path: string; // URL de cloud o path local
  uid_user: string; // ID de firebase
}