import { Injectable } from '@angular/core';
import { Constants } from '../core/constants';
import * as path from 'path';
import * as fs from 'fs-extra';
import log from 'electron-log';
import { Subject, Observable } from 'rxjs';
import { Utils } from '../core/utils';
import { Notebook } from '../data/entities/notebook';
import { TranslateService } from '@ngx-translate/core';
import { remote } from 'electron';
import { Note } from '../data/entities/note';
import * as moment from 'moment'
import { Moment, Duration } from 'moment';
import { NoteDateFormatResult } from './results/noteDateFormatResult';
import { Operation } from '../core/enums';
import { NoteOperationResult } from './results/noteOperationResult';
import { NotesCountResult } from './results/notesCountResult';
import { SearchService } from './search.service';
import * as sanitize from 'sanitize-filename';
import { DataStore } from '../data/dataStore';
import { NoteMarkResult } from './results/noteMarkResult';
import { NoteDetailsResult } from './results/noteDetailsResult';
import { ipcRenderer } from 'electron';
import { NoteExport } from '../core/noteExport';
import { SettingsService } from './settings.service';

@Injectable({
  providedIn: 'root',
})
export class CollectionService {
  private dataStore: DataStore = new DataStore();
  private isInitializing: boolean = false;
  private isInitialized: boolean = false;
  private globalEmitter = remote.getGlobal('globalEmitter');
  private openNoteIds: string[] = [];
  private collectionsChanged = new Subject();
  private notebookEdited = new Subject();
  private notebookDeleted = new Subject();
  private noteEdited = new Subject();
  private noteDeleted = new Subject();
  private notesCountChanged = new Subject<NotesCountResult>();
  private noteMarkChanged = new Subject<NoteMarkResult>();
  private noteNotebookChanged = new Subject();
  private setNoteOpenEventListener: any = this.setNoteOpenAsync.bind(this);
  private setNoteMarkEventListener: any = this.setNoteMark.bind(this);
  private setNotebookEventListener: any = this.setNotebook.bind(this);
  private getNoteDetailsEventListener: any = this.getNoteDetailsEventHandler.bind(this);
  private getNotebooksEventListener: any = this.getNotebooksEventHandler.bind(this);
  private setNoteTitleEventListener: any = this.setNoteTitleEventHandler.bind(this);
  private setNoteTextEventListener: any = this.setNoteTextEventHandler.bind(this);
  private deleteNoteEventListener: any = this.deleteNoteEventHandler.bind(this);

  constructor(private translateService: TranslateService, private searchService: SearchService,
    private settingsService: SettingsService) {
  }

  public collectionsChanged$: Observable<{}> = this.collectionsChanged.asObservable();
  public notebookEdited$: Observable<{}> = this.notebookEdited.asObservable();
  public notebookDeleted$: Observable<{}> = this.notebookDeleted.asObservable();
  public noteEdited$: Observable<{}> = this.noteEdited.asObservable();
  public noteDeleted$: Observable<{}> = this.noteDeleted.asObservable();
  public notesCountChanged$: Observable<NotesCountResult> = this.notesCountChanged.asObservable();
  public noteMarkChanged$: Observable<NoteMarkResult> = this.noteMarkChanged.asObservable();
  public noteNotebookChanged$: Observable<{}> = this.noteNotebookChanged.asObservable();

  private listenToNoteEvents(): void {
    // Remove listeners
    this.globalEmitter.removeListener(Constants.setNoteOpenEvent, this.setNoteOpenEventListener);
    this.globalEmitter.removeListener(Constants.setNoteMarkEvent, this.setNoteMarkEventListener);
    this.globalEmitter.removeListener(Constants.setNotebookEvent, this.setNotebookEventListener);
    this.globalEmitter.removeListener(Constants.getNoteDetailsEvent, this.getNoteDetailsEventListener);
    this.globalEmitter.removeListener(Constants.getNotebooksEvent, this.getNotebooksEventListener);
    this.globalEmitter.removeListener(Constants.setNoteTitleEvent, this.setNoteTitleEventListener);
    this.globalEmitter.removeListener(Constants.setNoteTextEvent, this.setNoteTextEventListener);
    this.globalEmitter.removeListener(Constants.deleteNoteEvent, this.deleteNoteEventListener);

    // Add listeners
    this.globalEmitter.on(Constants.setNoteOpenEvent, this.setNoteOpenEventListener);
    this.globalEmitter.on(Constants.setNoteMarkEvent, this.setNoteMarkEventListener);
    this.globalEmitter.on(Constants.setNotebookEvent, this.setNotebookEventListener);
    this.globalEmitter.on(Constants.getNoteDetailsEvent, this.getNoteDetailsEventListener);
    this.globalEmitter.on(Constants.getNotebooksEvent, this.getNotebooksEventListener);
    this.globalEmitter.on(Constants.setNoteTitleEvent, this.setNoteTitleEventListener);
    this.globalEmitter.on(Constants.setNoteTextEvent, this.setNoteTextEventListener);
    this.globalEmitter.on(Constants.deleteNoteEvent, this.deleteNoteEventListener);
  }

  public get hasStorageDirectory(): boolean {
    // 1. Get the storage directory from the settings
    let storageDirectory: string = this.settingsService.storageDirectory;

    if (!storageDirectory) {
      // Storage directory is empty
      log.info("Storage directory setting is empty");
      return false;
    }

    // 2. If a storage directory was found in the settings, check if it exists on disk.
    if (!fs.existsSync(storageDirectory)) {
      // Storage directory is not found on disk
      log.info(`Storage directory '${storageDirectory}' is not found on disk`);
      return false;
    }

    // Storage directory is OK.
    log.info(`Storage directory '${storageDirectory}' is OK`);
    return true;
  }

  public async getCollectionsAsync() {
    let storageDirectory: string = this.settingsService.storageDirectory;
    let fileNames: string[] = await fs.readdir(storageDirectory);
    let collections: string[] = [];

    for (let fileName of fileNames) {
      let absoluteFilePath: string = path.join(storageDirectory, fileName);
      let stat: any = await fs.stat(absoluteFilePath);

      if (stat.isDirectory()) {
        collections.push(fileName);
      }
    }

    return collections;
  }

  public async setStorageDirectoryAsync(parentDirectory: string): Promise<boolean> {
    try {
      // Generate storage directory path based on parent directory
      let storageDirectory: string = path.join(parentDirectory, Constants.collectionsDirectory);

      // Create storage directory if it doesn't exist
      if (!await fs.exists(storageDirectory)) {
        await fs.mkdir(storageDirectory);
        log.info(`Created storageDirectory '${storageDirectory}' on disk`);
      } else {
        log.info(`StorageDirectory '${storageDirectory}' already exists on disk. No need to create it.`);
      }

      // Save storage directory in the settings store
      this.settingsService.storageDirectory = storageDirectory;
      log.info(`Saved storage directory '${storageDirectory}' in settings store`);
    } catch (error) {
      log.error(`Could not create storage directory on disk. Cause: ${error}`);

      return false;
    }

    return true;
  }

  public async initializeAsync(): Promise<void> {
    // Prevents initializing multiple times. To prevent calling 
    // functions before initialization is complete, force a wait.
    if (this.isInitialized) {
      return;
    }

    if (this.isInitializing) {
      while (this.isInitializing) {
        await Utils.sleep(100);
      }

      return;
    }

    this.isInitializing = true;

    // Get the active collection from the settings
    let storageDirectory: string = this.settingsService.storageDirectory;
    let activeCollection: string = this.settingsService.activeCollection;
    let activeCollectionDirectory: string = "";

    if (activeCollection && Utils.collectionToPath(storageDirectory, activeCollection).includes(storageDirectory) &&
      Utils.collectionToPath(storageDirectory, activeCollection) !== storageDirectory && await fs.exists(Utils.collectionToPath(storageDirectory, activeCollection))) {
      // There is an active collection and the collection directory exists
      activeCollectionDirectory = Utils.collectionToPath(storageDirectory, activeCollection);
    } else {
      // There is no active collection or no collection directory
      // Get all collection directories in the storage directory
      let collections: string[] = await this.getCollectionsAsync();

      if (collections && collections.length > 0) {
        // If there are collection directories, take the first one.
        activeCollection = collections[0];
      } else {
        // If there are no collection directories, create a default collection.
        activeCollection = Constants.defaultCollection;
      }

      activeCollectionDirectory = Utils.collectionToPath(storageDirectory, activeCollection);
      this.settingsService.activeCollection = activeCollection;

      // If the collection directory doesn't exsist, create it.
      if (!await fs.exists(activeCollectionDirectory)) {
        await fs.mkdir(activeCollectionDirectory);
      }
    }

    let databaseFile: string = path.join(activeCollectionDirectory, `${activeCollection}.db`);

    // Now initialize the data store.
    await this.dataStore.initializeAsync(databaseFile);

    log.info(`Initialized data store: ${databaseFile}`);

    // Only an initialized collectionService can process global requests
    this.listenToNoteEvents();

    this.isInitializing = false;
    this.isInitialized = true;
  }

  public async addCollectionAsync(possiblyDirtyCollection: string): Promise<Operation> {
    // Check if a collection was provided
    if (!possiblyDirtyCollection) {
      log.error("possiblyDirtyCollection is null");
      return Operation.Error;
    }

    let sanitizedCollection: string = sanitize(possiblyDirtyCollection);

    try {
      // Check if there is already a collection with that name
      if (await this.collectionExistsAsync(sanitizedCollection)) {
        log.info(`Not adding collection '${sanitizedCollection}' because it already exists`);
        return Operation.Duplicate;
      }

      // Add the collection
      let storageDirectory: string = this.settingsService.storageDirectory;
      await fs.mkdir(Utils.collectionToPath(storageDirectory, sanitizedCollection));

      log.info(`Added collection '${sanitizedCollection}'`);

      // Activate the added collection
      this.settingsService.activeCollection = sanitizedCollection;
    } catch (error) {
      log.error(`Could not add collection '${sanitizedCollection}'. Cause: ${error}`);

      return Operation.Error;
    }

    this.isInitialized = false;
    this.collectionsChanged.next();

    return Operation.Success;
  }

  public async renameCollectionAsync(initialCollection: string, finalCollection: string): Promise<Operation> {
    if (!finalCollection) {
      log.error("finalCollection is null");
      return Operation.Error;
    }

    // No rename required
    if (initialCollection.toLowerCase() === finalCollection.toLowerCase()) {
      return Operation.Aborted;
    }

    try {

      if (await this.collectionExistsAsync(finalCollection)) {
        return Operation.Duplicate;
      }

      let storageDirectory: string = this.settingsService.storageDirectory;

      // Rename database file
      await fs.move(path.join(Utils.collectionToPath(storageDirectory, initialCollection), `${initialCollection}.db`), path.join(Utils.collectionToPath(storageDirectory, initialCollection), `${finalCollection}.db`));

      // Rename directory
      await fs.move(Utils.collectionToPath(storageDirectory, initialCollection), Utils.collectionToPath(storageDirectory, finalCollection));
      this.settingsService.activeCollection = finalCollection;
    } catch (error) {
      log.error(`Could not rename the collection '${initialCollection}' to '${finalCollection}'. Cause: ${error}`);
      return Operation.Error;
    }

    this.isInitialized = false;
    this.collectionsChanged.next();

    return Operation.Success;
  }

  public async deleteCollectionAsync(collection: string): Promise<Operation> {
    try {
      let storageDirectory: string = this.settingsService.storageDirectory;
      await fs.remove(Utils.collectionToPath(storageDirectory, collection));
      let collections: string[] = await this.getCollectionsAsync();

      if (collections && collections.length > 0) {
        this.settingsService.activeCollection = collections[0];
      } else {
        this.settingsService.activeCollection = "";
      }
    } catch (error) {
      log.error(`Could not delete the collection '${collection}'. Cause: ${error}`);
    }

    this.isInitialized = false;
    this.collectionsChanged.next();

    return Operation.Success;
  }

  public activateCollection(collection: string): void {
    this.settingsService.activeCollection = collection;
    this.isInitialized = false;
    this.collectionsChanged.next();
  }

  public getActiveCollection(): string {
    return this.settingsService.activeCollection;
  }

  public noteIsOpen(noteId: string): boolean {
    if (this.openNoteIds.includes(noteId)) {
      return true;
    }

    return false;
  }

  public hasOpenNotes(): boolean {
    return this.openNoteIds.length > 0;
  }

  public async getNotebooksAsync(includeAllNotes: boolean): Promise<Notebook[]> {
    let notebooks: Notebook[] = [];

    try {
      // Add the default notebooks
      if (includeAllNotes) {
        let allNotesNotebook: Notebook = new Notebook(await this.translateService.get('MainPage.AllNotes').toPromise());
        allNotesNotebook.id = Constants.allNotesNotebookId;
        allNotesNotebook.isDefault = true;
        notebooks.push(allNotesNotebook);
      }

      let unfiledNotesNotebook: Notebook = new Notebook(await this.translateService.get('MainPage.UnfiledNotes').toPromise());
      unfiledNotesNotebook.id = Constants.unfiledNotesNotebookId;
      unfiledNotesNotebook.isDefault = true;
      notebooks.push(unfiledNotesNotebook);

      // 4. Get the user defined notebooks
      let userNotebooks: Notebook[] = this.dataStore.getNotebooks();

      // 5. Add the user defined notebooks to the notebooks
      notebooks.push.apply(notebooks, userNotebooks);
    } catch (error) {
      log.error(`Could not get notebooks. Cause: ${error}`);
    }

    return notebooks;
  }

  public addNotebook(notebookName: string): Operation {
    // Check if a notebook name was provided
    if (!notebookName) {
      log.error("notebookName is null");
      return Operation.Error;
    }

    try {
      // Check if there is already a notebook with that name
      if (this.notebookExists(notebookName)) {
        log.info(`Not adding notebook '${notebookName}' to the data store because it already exists`);
        return Operation.Duplicate;
      }

      // Add the notebook to the data store
      this.dataStore.addNotebook(notebookName);
      log.info(`Added notebook '${notebookName}' to the data store`);
    } catch (error) {
      log.error(`Could not add notebook '${notebookName}'. Cause: ${error}`);

      return Operation.Error;
    }

    this.notebookEdited.next();

    return Operation.Success;
  }

  public async renameNotebookAsync(notebookId: string, newNotebookName: string): Promise<Operation> {
    // Check if a notebook name was provided
    if (!newNotebookName) {
      log.error("newNotebookName is null");
      return Operation.Error;
    }

    try {
      // Check if there is already a notebook with that name
      if (this.notebookExists(newNotebookName)) {
        return Operation.Duplicate;
      }

      // Get the notebook
      let notebook: Notebook = this.dataStore.getNotebookById(notebookId);

      if (notebook.name === newNotebookName) {
        // No rename required
        return Operation.Aborted;
      }

      // Rename the notebook
      notebook.name = newNotebookName;
      this.dataStore.updateNotebook(notebook);
    } catch (error) {
      log.error(`Could not rename the notebook with id='${notebookId}' to '${newNotebookName}'. Cause: ${error}`);
      return Operation.Error;
    }

    this.notebookEdited.next();

    return Operation.Success;
  }

  public getNotebookName(notebookId: string): string {
    return this.dataStore.getNotebookById(notebookId).name;
  }

  public async deleteNotebooksAsync(notebookIds: string[]): Promise<Operation> {
    let operation: Operation = Operation.Success;

    for (const notebookId of notebookIds) {
      try {
        this.dataStore.deleteNotebook(notebookId);
      } catch (error) {
        log.error(`Could not delete the notebook with id='${notebookId}'. Cause: ${error}`);
        operation = Operation.Error;
      }
    }

    this.notebookDeleted.next();

    return operation;
  }

  public async deleteNotesAsync(noteIds: string[]): Promise<Operation> {
    let operation: Operation = Operation.Success;

    for (const noteId of noteIds) {
      try {
        // 1. Delete note from data store
        this.dataStore.deleteNote(noteId);

        // 2. Delete all files from disk, which are related to the note.
        let notePath: string = this.getNotePath(noteId);
        let noteFilePath: string = path.join(notePath, `${noteId}${Constants.noteContentExtension}`);
        let noteStateFilePath: string = path.join(notePath, `${noteId}${Constants.noteStateExtension}`);

        // Note file
        fs.unlinkSync(noteFilePath, '');

        // Note state file
        if (fs.existsSync(noteStateFilePath)) {
          fs.unlinkSync(noteStateFilePath, '');
        }
      } catch (error) {
        log.error(`Could not delete the note with id='${noteId}'. Cause: ${error}`);
        operation = Operation.Error;
      }
    }

    this.noteDeleted.next();

    return operation;
  }

  public async getNotesAsync(notebookId: string, category: string, useExactDates: boolean): Promise<Note[]> {
    let notesCountResult: NotesCountResult = new NotesCountResult();

    let notes: Note[] = [];

    try {
      // Get the notes from the data store
      let uncategorizedNotes: Note[] = [];

      if (notebookId === Constants.allNotesNotebookId) {
        uncategorizedNotes = this.dataStore.getNotes();
      } else if (notebookId === Constants.unfiledNotesNotebookId) {
        uncategorizedNotes = this.dataStore.getUnfiledNotes();
      } else {
        uncategorizedNotes = this.dataStore.getNotebookNotes(notebookId);
      }

      // TODO: filter uncategorizedNotes by search text
      uncategorizedNotes = this.getFilteredNotes(uncategorizedNotes, this.searchService.searchText);

      // Fill in count
      notesCountResult.allNotesCount = uncategorizedNotes.length;

      let markedNotes: Note[] = uncategorizedNotes.filter(x => x.isMarked);
      notesCountResult.markedNotesCount = markedNotes.length;

      if (category === Constants.markedCategory) {
        notes = markedNotes;
      }

      // Fill in the display date & notes array
      for (let note of uncategorizedNotes) {
        if (category === Constants.allCategory) {
          notes.push(note);
        }

        let result: NoteDateFormatResult = await this.getNoteDateFormatAsync(note.modificationDate, useExactDates);

        // More counts
        if (result.isTodayNote) {
          if (category === Constants.todayCategory) {
            notes.push(note);
          }

          notesCountResult.todayNotesCount++;
        }

        if (result.isYesterdayNote) {
          if (category === Constants.yesterdayCategory) {
            notes.push(note);
          }

          notesCountResult.yesterdayNotesCount++;
        }

        if (result.isThisWeekNote) {
          if (category === Constants.thisWeekCategory) {
            notes.push(note);
          }

          notesCountResult.thisWeekNotesCount++;
        }

        // Date text
        note.displayModificationDate = result.dateText;
        note.displayExactModificationDate = this.getFormattedDate(note.modificationDate);
      }

      this.notesCountChanged.next(notesCountResult);
    } catch (error) {
      log.error(`Could not get notes. Cause: ${error}`);
    }

    return notes;
  }

  public addNote(baseTitle: string, notebookId: string): NoteOperationResult {
    let uniqueTitle: string = "";
    let result: NoteOperationResult = new NoteOperationResult(Operation.Success);

    // If a default notebook was selected, make sure the note is added as unfiled.
    if (notebookId === Constants.allNotesNotebookId || notebookId === Constants.unfiledNotesNotebookId) {
      notebookId = "";
    }

    try {
      // 1. Add note to data store
      uniqueTitle = this.getUniqueNewNoteNoteTitle(baseTitle);
      result.noteId = this.dataStore.addNote(uniqueTitle, notebookId);

      // 2. Create note file
      let activeCollection: string = this.settingsService.activeCollection;
      let storageDirectory: string = this.settingsService.storageDirectory;
      fs.writeFileSync(path.join(Utils.collectionToPath(storageDirectory, activeCollection), `${result.noteId}${Constants.noteContentExtension}`), '');

      this.noteEdited.next();
    } catch (error) {
      log.error(`Could not add note '${uniqueTitle}'. Cause: ${error}`);
      result.operation = Operation.Error;
    }

    return result;
  }

  public getNote(noteId: string): Note {
    return this.dataStore.getNoteById(noteId);
  }

  public async getNotebookAsync(noteId: string): Promise<Notebook> {
    let note: Note = this.dataStore.getNoteById(noteId);
    let notebook: Notebook = this.dataStore.getNotebookById(note.notebookId);

    if (!note.notebookId || !notebook) {
      notebook = new Notebook(await this.translateService.get('MainPage.UnfiledNotes').toPromise());
    }

    return notebook;
  }

  public setNoteMark(noteId: string, isMarked: boolean): void {
    let note: Note = this.dataStore.getNoteById(noteId);
    note.isMarked = isMarked;
    this.dataStore.updateNote(note);

    let markedNotes: Note[] = this.dataStore.getMarkedNotes();
    let result: NoteMarkResult = new NoteMarkResult(noteId, note.isMarked, markedNotes.length);

    this.noteMarkChanged.next(result);
    this.globalEmitter.emit(Constants.noteMarkChangedEvent, note.id, note.isMarked);
  }

  public setNotebook(notebookId: string, noteIds: string[]): Operation {
    let setNotebookOperation: Operation = Operation.Success;

    for (let noteId of noteIds) {
      try {
        let note: Note = this.dataStore.getNoteById(noteId);

        if (notebookId === Constants.allNotesNotebookId || notebookId === note.notebookId) {
          // Skip this note
          continue;
        }

        if (notebookId === Constants.unfiledNotesNotebookId) {
          notebookId = "";
        }

        note.notebookId = notebookId;
        this.dataStore.updateNote(note);
        this.sendNotebookNameAsync(noteId);
      } catch (error) {
        log.error(`Could not set the notebook for the note with id='${noteId}' to notebook with id='${notebookId}'. Cause: ${error}`);
        setNotebookOperation = Operation.Error;
      }
    }

    this.noteNotebookChanged.next();

    return setNotebookOperation;
  }

  public setNoteTitleEventHandler(noteId: string, initialNoteTitle: string, finalNoteTitle: string, callback: any) {
    let uniqueNoteTitle: string = finalNoteTitle.trim();

    if (uniqueNoteTitle.length === 0) {
      callback(new NoteOperationResult(Operation.Blank));
      return;
    }

    if (initialNoteTitle === uniqueNoteTitle) {
      log.error("Final title is the same as initial title. No rename required.");
      callback(new NoteOperationResult(Operation.Aborted));
      return;
    }

    try {
      // 1. Make sure the final title is unique
      uniqueNoteTitle = this.getUniqueNoteNoteTitle(finalNoteTitle);

      // 2. Rename the note
      let note: Note = this.dataStore.getNoteById(noteId);
      note.title = uniqueNoteTitle;
      this.dataStore.updateNote(note);

      log.info(`Renamed note with id=${noteId} from ${initialNoteTitle} to ${uniqueNoteTitle}.`);
    } catch (error) {
      log.error(`Could not rename the note with id='${noteId}' to '${uniqueNoteTitle}'. Cause: ${error}`);
      callback(new NoteOperationResult(Operation.Error));
      return;
    }

    let result: NoteOperationResult = new NoteOperationResult(Operation.Success);
    result.noteId = noteId;
    result.noteTitle = uniqueNoteTitle;

    this.noteEdited.next();
    callback(result);
  }

  public setNoteTextEventHandler(noteId: string, noteText: string, callback: any) {
    try {
      let note: Note = this.dataStore.getNoteById(noteId);
      note.text = noteText;
      this.dataStore.updateNote(note);
    } catch (error) {
      log.error(`Could not set text for the note with id='${noteId}' in the data store. Cause: ${error}`);
      callback(Operation.Error);
      return;
    }

    callback(Operation.Success);
    return;
  }

  public deleteNoteEventHandler(noteId: string) {
    this.deleteNotesAsync([noteId]);
  }

  public async importFromOldVersionAsync(directoryContainingExportFiles: string): Promise<boolean> {
    let notebooksExportFile: string = path.join(directoryContainingExportFiles, "Notebooks.json");
    let notesExportFile: string = path.join(directoryContainingExportFiles, "Notes.json");

    let isImportSuccessful: boolean = true;

    try {
      // Notebooks
      try {
        if (await fs.exists(notebooksExportFile)) {
          let notebooksJson: string = await fs.readFile(notebooksExportFile);
          let jsonNotebooks = JSON.parse(notebooksJson);

          log.info(`${notebooksExportFile} was found. Importing notebooks.`);

          for (let jsonNotebook of jsonNotebooks) {
            try {
              if (!this.notebookExists(jsonNotebook.Name)) {
                this.dataStore.addNotebook(jsonNotebook.Name);
              }
            } catch (error) {
              log.error(`An error occurred while importing a notebook from an old version. Cause: ${error}`);
              isImportSuccessful = false;
            }
          }
        } else {
          log.info(`${notebooksExportFile} was not found. Not importing notebooks.`);
        }
      } catch (error) {
        log.error(`An error occurred while importing notebooks from an old version. Cause: ${error}`);
        isImportSuccessful = false;
      }


      // Notes
      try {
        if (await fs.exists(notesExportFile)) {
          let notesJson: string = await fs.readFile(notesExportFile);
          let jsonNotes = JSON.parse(notesJson);

          log.info(`${notesExportFile} was found. Importing notes.`);

          for (let jsonNote of jsonNotes) {
            try {
              if (!this.notebookExists(jsonNote.Title)) {
                let notebookId: string = "";

                try {
                  if (jsonNote.Notebook) {
                    let notebook: Notebook = this.dataStore.getNotebookByName(jsonNote.Notebook);

                    if (notebook) {
                      notebookId = notebook.id;
                    }
                  }
                } catch (error) {
                  log.error(`An error occurred while trying to find a notebook for a note. Cause: ${error}`);
                }

                this.dataStore.addNote(jsonNote.Title, notebookId);

                let note: Note = this.dataStore.getNoteByTitle(jsonNote.Title);
                note.text = jsonNote.Text;
                note.creationDate = moment(jsonNote.CreationDate, 'YYYY-MM-DD HH:mm:ss').valueOf();
                note.modificationDate = moment(jsonNote.ModificationDate, 'YYYY-MM-DD HH:mm:ss').valueOf();
                note.isMarked = jsonNote.IsMarked;
                this.dataStore.updateNoteWithoutDate(note);

                let quillText: string = `{"ops":[{"insert":${JSON.stringify(jsonNote.Text)}}]}`;

                let activeCollection: string = this.settingsService.activeCollection;
                let storageDirectory: string = this.settingsService.storageDirectory;
                await fs.writeFile(path.join(Utils.collectionToPath(storageDirectory, activeCollection), `${note.id}${Constants.noteContentExtension}`), quillText);
              }
            } catch (error) {
              log.error(`An error occurred while importing a note from an old version. Cause: ${error}`);
              isImportSuccessful = false;

              try {
                // Make sure there are no erroneous notes left in the data store
                let note: Note = this.dataStore.getNoteByTitle(jsonNote.Title);

                if (note) {
                  this.dataStore.deleteNote(note.id);
                }
              } catch (error) {
                log.error(`Could note delete note from data store. Cause: ${error}`);
              }
            }
          }
        } else {
          log.info(`${notesExportFile} was not found. Not importing notes.`);
        }
      } catch (error) {
        log.error(`An error occurred while importing notes from an old version. Cause: ${error}`);
        isImportSuccessful = false;
      }

    } catch (error) {
      log.error(`An error occurred while importing notebooks and/or notes from an old version. Cause: ${error}`);
      isImportSuccessful = false;
    }

    return isImportSuccessful;
  }

  public async importNoteFilesAsync(noteFilePaths: string[], notebookId: string = null): Promise<Operation> {
    let numberofImportedNoteFiles: number = 0;
    let operation: Operation = Operation.Success;

    for (let noteFilePath of noteFilePaths) {
      try {
        let noteFileContent: string = await fs.readFile(noteFilePath);
        let noteExport: NoteExport = JSON.parse(noteFileContent);
        let proposedNoteTitle: string = `${noteExport.title} (${await this.translateService.get('Notes.Imported').toPromise()})`
        let uniqueNoteTitle: string = this.getUniqueNoteNoteTitle(proposedNoteTitle);

        this.dataStore.addNote(uniqueNoteTitle, "");

        let note: Note = this.dataStore.getNoteByTitle(uniqueNoteTitle);
        note.text = noteExport.text;

        if (notebookId && notebookId !== Constants.allNotesNotebookId && notebookId !== Constants.unfiledNotesNotebookId) {
          note.notebookId = notebookId;
        }

        this.dataStore.updateNoteWithoutDate(note);

        let activeCollection: string = this.settingsService.activeCollection;
        let storageDirectory: string = this.settingsService.storageDirectory;
        await fs.writeFile(path.join(Utils.collectionToPath(storageDirectory, activeCollection), `${note.id}${Constants.noteContentExtension}`), noteExport.content);
        numberofImportedNoteFiles++;
      } catch (error) {
        log.error(`An error occurred while importing note file '${noteFilePath}'. Cause: ${error}`);
        operation = Operation.Error;
      }
    }

    if (numberofImportedNoteFiles > 0) {
      this.noteEdited.next();
    }

    return operation;
  }

  private getNotePath(noteId: string) {
    let activeCollection: string = this.settingsService.activeCollection;
    let storageDirectory: string = this.settingsService.storageDirectory;
    return Utils.collectionToPath(storageDirectory, activeCollection);
  }

  private async collectionExistsAsync(collection: string): Promise<boolean> {
    let collections: string[] = await this.getCollectionsAsync();
    let existingCollections: string[] = collections.filter(x => x.toLowerCase() === collection.toLowerCase());

    return existingCollections && existingCollections.length > 0;
  }

  private async getNoteDetailsEventHandler(noteId: string, callback: any): Promise<void> {
    let note: Note = this.dataStore.getNoteById(noteId);
    let notebookName: string = await this.translateService.get('MainPage.UnfiledNotes').toPromise();

    if (note.notebookId) {
      let notebook: Notebook = this.dataStore.getNotebookById(note.notebookId);

      if (notebook) {
        notebookName = notebook.name;
      }
    }

    callback(new NoteDetailsResult(note.title, notebookName, note.isMarked));
  }

  private async sendNotebookNameAsync(noteId: string) {
    let note: Note = this.dataStore.getNoteById(noteId);
    let notebookName: string = await this.translateService.get('MainPage.UnfiledNotes').toPromise();

    if (note.notebookId) {
      let notebook: Notebook = this.dataStore.getNotebookById(note.notebookId);

      if (notebook) {
        notebookName = notebook.name;
      }
    }

    this.globalEmitter.emit(Constants.notebookChangedEvent, noteId, notebookName);
  }

  private async getNotebooksEventHandler(callback: any): Promise<void> {
    let notebooks: Notebook[] = await this.getNotebooksAsync(false);
    callback(notebooks);
  }

  private async setNoteOpenAsync(noteId: string, isOpen: boolean): Promise<void> {
    if (isOpen) {
      if (!this.openNoteIds.includes(noteId)) {
        this.openNoteIds.push(noteId);

        let notePath: string = this.getNotePath(noteId);
        log.info(`note directory=${notePath}`);
        let arg: any = { notePath: notePath, noteId: noteId };
        ipcRenderer.send('open-note-window', arg);
      }
    } else {
      if (this.openNoteIds.includes(noteId)) {
        this.openNoteIds.splice(this.openNoteIds.indexOf(noteId), 1);
      }
    }
  }

  private getUniqueNewNoteNoteTitle(baseTitle: string): string {
    let counter: number = 1;
    let uniqueTitle: string = `${baseTitle} ${counter}`;

    let notesWithIdenticalBaseTitle: Note[] = this.dataStore.getNotesWithIdenticalBaseTitle(baseTitle);
    let similarTitles: string[] = notesWithIdenticalBaseTitle.map(x => x.title);

    while (similarTitles.includes(uniqueTitle)) {
      counter++;
      uniqueTitle = `${baseTitle} ${counter}`;
    }

    return uniqueTitle;
  }

  private getUniqueNoteNoteTitle(baseTitle: string): string {
    let counter: number = 0;
    let uniqueTitle: string = baseTitle;

    let notesWithIdenticalBaseTitle: Note[] = this.dataStore.getNotesWithIdenticalBaseTitle(baseTitle);
    let similarTitles: string[] = notesWithIdenticalBaseTitle.map(x => x.title);

    while (similarTitles.includes(uniqueTitle)) {
      counter++;
      uniqueTitle = `${baseTitle} (${counter})`;
    }

    return uniqueTitle;
  }

  private notebookExists(notebookName: string): boolean {
    let notebook: Notebook = this.dataStore.getNotebookByName(notebookName);

    return notebook != null;
  }

  private noteExists(noteTitle: string): boolean {
    let note: Note = this.dataStore.getNoteByTitle(noteTitle);

    return note != null;
  }

  private async getNoteDateFormatAsync(millisecondsSinceEpoch: number, useExactDates: boolean): Promise<NoteDateFormatResult> {
    let result: NoteDateFormatResult = new NoteDateFormatResult();
    let nowDateonly: Moment = moment().startOf('day');
    let modificationDateOnly: Moment = moment(millisecondsSinceEpoch).startOf('day');
    let duration: Duration = moment.duration(nowDateonly.diff(modificationDateOnly));

    if (duration.asMonths() >= 12) {
      result.dateText = await this.translateService.get('NoteDates.LongAgo').toPromise();
    } else if (duration.asMonths() >= 11) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 11 }).toPromise();
    } else if (duration.asMonths() >= 10) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 10 }).toPromise();
    } else if (duration.asMonths() >= 9) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 9 }).toPromise();
    } else if (duration.asMonths() >= 8) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 8 }).toPromise();
    } else if (duration.asMonths() >= 7) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 7 }).toPromise();
    } else if (duration.asMonths() >= 6) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 6 }).toPromise();
    } else if (duration.asMonths() >= 5) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 5 }).toPromise();
    } else if (duration.asMonths() >= 4) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 4 }).toPromise();
    } else if (duration.asMonths() >= 3) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 3 }).toPromise();
    } else if (duration.asMonths() >= 2) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 2 }).toPromise();
    } else if (duration.asMonths() >= 1) {
      result.dateText = await this.translateService.get('NoteDates.MonthsAgo', { count: 1 }).toPromise();
    } else if (duration.asDays() >= 21) {
      result.dateText = await this.translateService.get('NoteDates.WeeksAgo', { count: 3 }).toPromise();
    } else if (duration.asDays() >= 14) {
      result.dateText = await this.translateService.get('NoteDates.WeeksAgo', { count: 2 }).toPromise();
    } else if (duration.asDays() >= 8) {
      result.dateText = await this.translateService.get('NoteDates.LastWeek').toPromise();
    } else if (duration.asDays() >= 7) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 7 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 6) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 6 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 5) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 5 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 4) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 4 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 3) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 3 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 2) {
      result.dateText = await this.translateService.get('NoteDates.DaysAgo', { count: 2 }).toPromise();
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 1) {
      result.dateText = await this.translateService.get('NoteDates.Yesterday').toPromise();
      result.isYesterdayNote = true;
      result.isThisWeekNote = true;
    } else if (duration.asDays() >= 0) {
      result.dateText = await this.translateService.get('NoteDates.Today').toPromise();
      result.isTodayNote = true;
      result.isThisWeekNote = true;
    }

    if (useExactDates) {
      result.dateText = this.getFormattedDate(millisecondsSinceEpoch);
    }

    return result;
  }

  private getFormattedDate(millisecondsSinceEpoch: number) {
    let m: Moment = moment(millisecondsSinceEpoch);
    return m.format("MMMM D, YYYY");
  }

  private getFilteredNotes(unfilteredNotes: Note[], filter: string): Note[] {
    // When there is no filter, return the original collection.
    if (!filter || filter.trim().length === 0) {
      return unfilteredNotes;
    }

    let searchTextPieces: string[] = filter.trim().split(" ");

    return unfilteredNotes.filter((x) => Utils.containsAll(`${x.title} ${x.text}`, searchTextPieces));
  }
}