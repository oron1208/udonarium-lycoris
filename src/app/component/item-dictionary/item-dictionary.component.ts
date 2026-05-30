import { Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core';

export interface DictionaryCategory {
  id: string;
  name: string;
  items: DictionaryItem[];
}

export interface DictionaryItem {
  name: string;
  type: string; // 'note', 'numberResource', 'checkList'
  description: string;
}

export interface Dictionary {
  name: string;
  version: string;
  categories: DictionaryCategory[];
}

@Component({
  selector: 'item-dictionary',
  templateUrl: './item-dictionary.component.html',
  styleUrls: ['./item-dictionary.component.css']
})
export class ItemDictionaryComponent implements OnInit {
  dictionaries: Dictionary[] = [];
  selectedDictionary: Dictionary | null = null;
  expandedCategories: Set<string> = new Set();
  searchTerm: string = '';
  searchResults: DictionaryItem[] = [];
  isSearching: boolean = false;

  ngOnInit() {
    this.loadDictionaries();
  }

  private async loadDictionaries() {
    const files = [
      { path: './assets/dictionaries/dnd5e.json', name: 'D&D 5e' },
      { path: './assets/dictionaries/coc6.json', name: 'CoC 6版' },
    ];
    for (const f of files) {
      try {
        const response = await fetch(f.path);
        if (response.ok) {
          const dict: Dictionary = await response.json();
          this.dictionaries.push(dict);
        }
      } catch (e) {
        console.warn('Failed to load dictionary:', f.name, e);
      }
    }
    if (this.dictionaries.length > 0) {
      this.selectedDictionary = this.dictionaries[0];
    }
  }

  selectDictionary(dict: Dictionary) {
    this.selectedDictionary = dict;
    this.searchTerm = '';
    this.isSearching = false;
    this.searchResults = [];
  }

  toggleCategory(categoryId: string) {
    if (this.expandedCategories.has(categoryId)) {
      this.expandedCategories.delete(categoryId);
    } else {
      this.expandedCategories.add(categoryId);
    }
  }

  isExpanded(categoryId: string): boolean {
    return this.expandedCategories.has(categoryId);
  }

  onSearchInput() {
    this.isSearching = this.searchTerm.trim().length > 0;
    if (!this.isSearching || !this.selectedDictionary) {
      this.searchResults = [];
      return;
    }
    const term = this.searchTerm.trim().toLowerCase();
    this.searchResults = [];
    for (const cat of this.selectedDictionary.categories) {
      for (const item of cat.items) {
        if (item.name.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)) {
          this.searchResults.push(item);
        }
      }
    }
  }

  onDragStart(event: DragEvent, item: DictionaryItem) {
    const data = JSON.stringify(item);
    event.dataTransfer?.setData('text/plain', data);
    event.dataTransfer!.effectAllowed = 'copy';
  }

  getFilteredCategories(): DictionaryCategory[] {
    if (!this.selectedDictionary) return [];
    if (this.isSearching) {
      // When searching, return categories that have matching items
      const term = this.searchTerm.trim().toLowerCase();
      return this.selectedDictionary.categories
        .map(cat => ({
          ...cat,
          items: cat.items.filter(item =>
            item.name.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)
          )
        }))
        .filter(cat => cat.items.length > 0);
    }
    return this.selectedDictionary.categories;
  }
}
