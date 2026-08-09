<div align="center">

# 🛡️ SD-Vault

**Déchargement intelligent, tri rapide RAW+JPEG & archivage haute performance pour cartes SD.**

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?style=for-the-badge&logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Stable-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Cross-Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)](https://github.com/alexlouf/SonyPhotoExtractor/releases)

<p align="center">
  <b>SD-Vault</b> est une application de bureau moderne et ultra-rapide conçue pour les photographes et vidéastes.<br />
  Elle automatise le tri, le déchargement et l'organisation des médias issus de cartes SD (Sony, Canon, Fuji, Nikon, etc.).
</p>

</div>

---

## ✨ Fonctionnalités clés

- ⚡ **Scan Multithreadé Ultra-Rapide (Rust / Rayon)**
  - Extraction à la volée des aperçus JPEG intégrés aux conteneurs RAW (Sony ARW, Canon CR3/CR2, Nikon NEF, Fuji RAF, DNG, etc.) pour des prévisualisations instantanées sans charger les gros fichiers en mémoire.
  - Streaming vidéo fluide avec gestion des requêtes partielles (Range HTTP).

- 🧠 **Appariement Intelligent RAW + JPEG (Stacks)**
  - Détection automatique et regroupement des fichiers RAW + JPEG pris simultanément.
  - Basculez en un clic entre l'importation complète (**RAW+JPG**) ou **JPEG Seul** (pour économiser de l'espace disque).
  - Contrôle global, par journée ou par photo.

- ⚡ **Visionneuse & Inspecteur de Rafales (Burst Inspector)**
  - Regroupement automatique des séries de prises de vue en rafale avec précision EXIF sous-seconde (`SubSecTimeOriginal`).
  - **Culling intelligent** : Par défaut, seule la **dernière photo** de la rafale est sélectionnée.
  - Inspecteur dédié avec mode **Solo** et mode **Côte-à-Côte (Split View)** pour comparer n'importe quel cliché à la photo de référence.
  - Indication d'état partiel avec cases à cocher à tirets (`−`).

- ⭐ **Favoris & Hardlinks à Zéro Espace Disque (0 MB)**
  - Marquez vos plus beaux clichés en favoris (`F` ou icône étoile).
  - Les favoris sont créés sous forme de **liens matériels (Hardlinks)** dans un dossier `favoris/`, n'occupant **aucun Mo supplémentaire** sur votre stockage.

- 📁 **Archivage Propre à la Demande (Lazy Creation)**
  - Structuration automatique par date de prise de vue (`AAAA-MM-JJ - Suffixe`).
  - Création intelligente des sous-dossiers (`jpg/`, `raw/`, `video/`, `favoris/`) **uniquement s'ils contiennent des fichiers**.
  - Choix du mode d'importation : **Copier** (conserve la carte SD intacte) ou **Déplacer** (libère la carte SD après transfert).

- 🎨 **Interface Sombre Glassmorphism & Navigation Clavier**
  - Design épuré, fluide et réactif.
  - Naviguez instantanément au clavier : `←` / `→` (déplacement), `Espace` / `S` (sélectionner), `F` (favori), `Échap` (fermer).

---

## 📸 Aperçu de l'Interface

```
+-----------------------------------------------------------------------------------+
|  🛡️ SD-Vault                               Déchargement & archivage de médias     |
+-----------------------------------------------------------------------------------+
|  📁 Dossier Source (Carte SD) : [ E:\DCIM\100MSDCF                        ] [Parcourir] [Scanner] |
|  📁 Dossier Destination      : [ D:\Photos\Archives                       ] [Parcourir]          |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  📅 2026-08-09  [45 JPG, 45 RAW, 2 Vidéos, 3 Rafales]        Suffixe: [ Bad_Match ]|
|  +--------------+  +--------------+  +--------------+  +--------------+          |
|  | [✓] RAW+JPG  |  | [-] Rafale(5)|  | [✓] Vidéo    |  | [✓] RAW+JPG  |          |
|  | DSC01928.JPG |  | DSC01934.JPG |  | MV00102.MP4  |  | DSC01940.JPG |          |
|  +--------------+  +--------------+  +--------------+  +--------------+          |
|                                                                                   |
+-----------------------------------------------------------------------------------+
| 📊 48 fichiers sélectionnés (2.4 GB)      [ Mode: Copier / Déplacer ] [ Lancer l'import ] |
+-----------------------------------------------------------------------------------+
```

---

## ⌨️ Raccourcis Clavier

| Raccourci | Action |
| :--- | :--- |
| `Double-Clic` | Ouvrir la photo en plein écran (Lightbox) ou la rafale (Inspecteur) |
| `←` / `→` | Photo précédente / suivante dans la Lightbox ou la Rafale |
| `Espace` ou `S` | Basculer la sélection pour l'import |
| `F` | Mettre / retirer des favoris (Étoile) |
| `Échap` | Fermer la Lightbox ou l'Inspecteur de rafale |

---

## 🚀 Installation & Exécution

### Télécharger la version précompilée
Rendez-vous sur la page des [**Releases GitHub**](https://github.com/alexlouf/SonyPhotoExtractor/releases) pour télécharger la dernière version officielle :
- **Windows** : `.msi` ou `.exe`
- **Linux** : `.AppImage` ou `.deb`
- **macOS** : `.dmg` ou `.app`

### Compiler depuis les sources

#### Prérequis
1. [Node.js](https://nodejs.org/) (v18+)
2. [Rust](https://www.rust-lang.org/) stable
3. Dépendances de build Linux (Ubuntu / Debian) :
   ```bash
   sudo apt update
   sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
   ```

#### Étapes de compilation
```bash
# 1. Cloner le dépôt
git clone https://github.com/alexlouf/SonyPhotoExtractor.git
cd SonyPhotoExtractor

# 2. Installer les dépendances frontend
npm install

# 3. Lancer en mode développement
npm run tauri dev

# 4. Compiler le paquet de production
npm run tauri build
```

---

## 🛠️ Architecture Technique

- **Frontend** : HTML5, Vanilla CSS3 (Design System Glassmorphism HSL), JavaScript ES6 Modules.
- **Iconographie** : Lucide Icons.
- **Backend & Core Engine** : Rust (Tauri v2).
  - **Traitement parallèle** : `rayon`
  - **Parsing EXIF & Vignettes** : `kamadak-exif`
  - **Optimisations I/O** : Protocoles personnalisés Tauri `vault-asset://` & requêtes HTTP par plages de d'octets (Range Requests).

---

## 📄 Licence

Ce projet est sous licence **MIT**. Vous êtes libre de l'utiliser, le modifier et le distribuer selon vos besoins.
